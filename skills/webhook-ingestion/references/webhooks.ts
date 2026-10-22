// Webhook ingestion: verify → store once → process async with retries → dead-letter → replay → reconcile.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from './pg-transaction.ts';
import { runLoops } from './worker-loop.ts';

// ---------- 1. Signature verification (on the RAW body, before JSON.parse) ----------

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Generic HMAC check (VNPay/MoMo/GitHub style): signature = hex(HMAC(secret, data)). */
export function verifyHmacHex(secret: string, data: string | Buffer, signatureHex: string, algo: 'sha256' | 'sha512' = 'sha256'): boolean {
  const expected = createHmac(algo, secret).update(data).digest('hex');
  return safeEqualHex(expected, signatureHex.trim().toLowerCase());
}

/**
 * Timestamped scheme (Stripe style): header "t=<unix>,v1=<hex>[,v1=<hex>]",
 * signed payload "<t>.<rawBody>". The tolerance window blocks replay of captured requests.
 */
export function verifyTimestampedSignature(opts: {
  secret: string;
  rawBody: string | Buffer;
  header: string | undefined;
  toleranceSec?: number;
  nowSec?: number;
}): boolean {
  if (!opts.header) return false;
  const parts = opts.header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || sigs.length === 0) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return false;
  const expected = createHmac('sha256', opts.secret).update(`${t}.`).update(opts.rawBody).digest('hex');
  return sigs.some((s) => safeEqualHex(expected, s));
}

// ---------- 2. Ingest: insert once, ack fast ----------

export interface InboundEvent {
  provider: string;
  eventId: string;
  eventType: string;
  payload: unknown;
}

/** Returns inserted=false for duplicates. Respond 2xx either way — the provider only needs to stop retrying. */
export async function ingest(db: pg.Pool | pg.PoolClient, e: InboundEvent, source: 'webhook' | 'reconcile' = 'webhook') {
  const res = await db.query(
    `INSERT INTO webhook_inbox (provider, event_id, event_type, payload, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [e.provider, e.eventId, e.eventType, JSON.stringify(e.payload), source],
  );
  return { inserted: res.rowCount === 1, id: res.rows[0]?.id as string | undefined };
}

// ---------- 3. Worker: claim with SKIP LOCKED, process in a transaction, back off, dead-letter ----------

export interface InboxRow {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  payload: any;
  attempts: number;
  source: string;
}

/**
 * Handlers get the transaction client: DB side effects commit atomically with "done".
 * External side effects (emails, provider API calls) must use an idempotency key, e.g. `${provider}:${event_id}`.
 */
export type Handler = (row: InboxRow, tx: pg.PoolClient) => Promise<void>;

/** done · retry (back to pending, with backoff) · dead · ignored (no handler) · lost (another worker owns it now). */
export type Outcome = 'done' | 'retry' | 'dead' | 'ignored' | 'lost';

export interface WorkerOptions {
  pool: pg.Pool;
  /** Keyed by `${provider}:${event_type}`, falling back to `${provider}:*`. */
  handlers: Record<string, Handler>;
  maxAttempts?: number; // default 8
  batchSize?: number; // default 10
  baseDelayMs?: number; // default 2_000
  maxDelayMs?: number; // default 1h
  /**
   * A row still 'processing' this long after its claim, and no longer locked by a live handler transaction, belongs
   * to a worker that died: it is claimed again. Default 300.
   */
  stuckAfterSec?: number;
  random?: () => number; // injectable for tests
  onDead?: (row: InboxRow, error: unknown) => void; // alert here
  /**
   * Rows of one claimed batch processed in parallel (each in its own transaction). Default 1.
   * Handlers are I/O-bound (DB writes, provider API calls), so 4–8 cuts drain time several-fold.
   * Raise it only when handlers are safe to run concurrently for *different* events of the same
   * object — e.g. they lock the order row (SELECT … FOR UPDATE) or apply state changes conditionally.
   * Keep it ≤ the pool size minus what the claim query and the rest of the app need.
   * A batch finishes only when its slowest row does; with handlers of uneven latency prefer
   * run({ loops }) (the same safety conditions apply).
   */
  concurrency?: number;
}

export interface RunOptions {
  /** Independent claim → process loops (default 4). Each holds a pool connection while a handler runs. */
  loops?: number;
  /** Pause after an empty claim or an error, ms (default 1000). */
  idleMs?: number;
  /** Abort to stop. run() resolves once every loop has finished the rows it already claimed. */
  signal: AbortSignal;
  /** Claim failures (database unreachable…). The loop backs off for idleMs and keeps going. */
  onError?: (err: unknown) => void;
}

/** Exponential backoff with "equal jitter": never ~0, never synchronized across rows. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** A claimed row and the lease that proves this worker still owns it. */
type Claimed = InboxRow & { lease_id: string };

const positiveInt = (v: number, name: string) => {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`webhook worker: ${name} must be a positive integer, got ${v}`);
  return v;
};

/**
 * Processes the inbox. Every claim gets a new lease id, and only the holder of the current lease may finish a row:
 * the handler's transaction starts by locking its own row as that holder. While the lock is held, the claim's
 * SKIP LOCKED passes over the row, so a handler slower than `stuckAfterSec` is never started a second time, and a
 * worker that lost its row can't overwrite the outcome of the one that took it over.
 */
export class InboxWorker {
  readonly #pool: pg.Pool;
  readonly #handlers: Record<string, Handler>;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #stuckAfterSec: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #random: () => number;
  readonly #onDead?: (row: InboxRow, error: unknown) => void;

  constructor(o: WorkerOptions) {
    this.#pool = o.pool;
    this.#handlers = o.handlers;
    this.#maxAttempts = positiveInt(o.maxAttempts ?? 8, 'maxAttempts');
    this.#batchSize = positiveInt(o.batchSize ?? 10, 'batchSize');
    this.#concurrency = positiveInt(o.concurrency ?? 1, 'concurrency');
    this.#stuckAfterSec = positiveInt(o.stuckAfterSec ?? 300, 'stuckAfterSec');
    this.#baseDelayMs = o.baseDelayMs ?? 2_000;
    this.#maxDelayMs = o.maxDelayMs ?? 3_600_000;
    this.#random = o.random ?? Math.random;
    this.#onDead = o.onDead;
  }

  /** One claim → process tick. run() loops it; call it directly from tests or your own scheduler. */
  async processOnce(): Promise<Outcome[]> {
    const rows = await this.#claim();
    const results: Outcome[] = new Array(rows.length);
    let next = 0;
    // A fixed number of lanes pulling from the batch: bounded parallelism, results in claim order.
    const lane = async () => {
      while (next < rows.length) {
        const i = next++;
        results[i] = await this.#process(rows[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, rows.length) }, lane));
    return results;
  }

  /**
   * The worker process: `loops` independent claim → process loops. Better than one loop with
   * `concurrency` lanes when handler latency varies: a batch only ends when its slowest row does, so one
   * slow provider call idles every other lane, while independent loops keep claiming (heavy-tailed
   * handlers drained 1.8× faster, docs/performance.md). Keep `batchSize` small (2–5) here: rows a loop
   * has claimed wait behind its current one. Await the returned promise in your shutdown hook after
   * aborting, or a deploy strands claimed rows in 'processing' until `stuckAfterSec`.
   */
  run(r: RunOptions): Promise<void> {
    return runLoops({ tick: async () => (await this.processOnce()).length > 0, signal: r.signal, loops: r.loops ?? 4, idleMs: r.idleMs, onError: r.onError });
  }

  async #claim(): Promise<Claimed[]> {
    // Two branches, each walking its own partial index in order and stopping after LIMIT rows: rows stuck
    // in 'processing' (a worker died) first, then due 'pending' rows. A single `pending OR stuck` filter
    // can't use either index's order, so Postgres fetches and sorts the whole due backlog on every claim:
    // the claim slows down exactly when a backlog builds up (docs/performance.md).
    const { rows } = await this.#pool.query<Claimed>(
      `UPDATE webhook_inbox
         SET status = 'processing', locked_at = now(), attempts = attempts + 1, lease_id = gen_random_uuid()
       WHERE id IN (
         SELECT id FROM (
           SELECT id FROM webhook_inbox
           WHERE status = 'processing' AND locked_at < now() - make_interval(secs => $2)
           ORDER BY locked_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED) stuck
         UNION ALL
         SELECT id FROM (
           SELECT id FROM webhook_inbox
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED) due
         LIMIT $1)
       RETURNING id, provider, event_id, event_type, payload, attempts, source, lease_id`,
      [this.#batchSize, this.#stuckAfterSec],
    );
    return rows;
  }

  async #process(row: Claimed): Promise<Outcome> {
    const handler = this.#handlers[`${row.provider}:${row.event_type}`] ?? this.#handlers[`${row.provider}:*`];
    try {
      return await withTransaction(this.#pool, async (tx) => {
        const own = await tx.query(`SELECT 1 FROM webhook_inbox WHERE id = $1 AND lease_id = $2 FOR UPDATE`, [row.id, row.lease_id]);
        if (own.rowCount === 0) return 'lost';
        if (!handler) {
          // Unknown event types are acknowledged, not retried forever. Keep the row for audit.
          await tx.query(
            `UPDATE webhook_inbox SET status = 'done', processed_at = now(), locked_at = NULL, lease_id = NULL, last_error = 'ignored: no handler' WHERE id = $1`,
            [row.id],
          );
          return 'ignored';
        }
        await handler(row, tx);
        await tx.query(
          `UPDATE webhook_inbox SET status = 'done', processed_at = now(), locked_at = NULL, lease_id = NULL, last_error = NULL WHERE id = $1`,
          [row.id],
        );
        return 'done';
      });
    } catch (err) {
      // The handler threw, or its connection died (failover, idle_in_transaction_session_timeout): the transaction
      // rolled back, so nothing it did happened. Back off, unless the row has changed hands meanwhile.
      return this.#fail(row, err);
    }
  }

  async #fail(row: Claimed, err: unknown): Promise<Outcome> {
    const dead = row.attempts >= this.#maxAttempts;
    const res = await this.#pool.query(
      `UPDATE webhook_inbox
         SET status = $3, locked_at = NULL, lease_id = NULL, last_error = $4,
             next_attempt_at = now() + make_interval(secs => $5::float8 / 1000)
       WHERE id = $1 AND lease_id = $2`,
      [
        row.id,
        row.lease_id,
        dead ? 'dead' : 'pending',
        String(err instanceof Error ? err.message : err).slice(0, 2000),
        backoffMs(row.attempts, this.#baseDelayMs, this.#maxDelayMs, this.#random),
      ],
    );
    if (res.rowCount === 0) return 'lost';
    if (dead) this.#onDead?.(row, err);
    return dead ? 'dead' : 'retry';
  }
}

export const createInboxWorker = (o: WorkerOptions) => new InboxWorker(o);

// ---------- 4. Replay: put dead (or any selected) events back in the queue ----------

export async function replay(pool: pg.Pool, filter: { ids?: string[]; provider?: string; eventType?: string; status?: 'dead' | 'done' }) {
  const res = await pool.query(
    `UPDATE webhook_inbox
       SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_at = NULL, lease_id = NULL, last_error = NULL
     WHERE status = $1
       AND ($2::bigint[] IS NULL OR id = ANY($2))
       AND ($3::text IS NULL OR provider = $3)
       AND ($4::text IS NULL OR event_type = $4)`,
    [filter.status ?? 'dead', filter.ids ?? null, filter.provider ?? null, filter.eventType ?? null],
  );
  return res.rowCount ?? 0;
}

/**
 * Retention: delete processed rows older than the window, in batches (short locks, no table-long
 * DELETE). Dead letters are never deleted — they need a human.
 * The window must be longer than the provider's longest retry period (Stripe retries for up to 3 days):
 * once a row is gone, the dedup key is gone too, and a late redelivery of that event is processed again.
 */
export async function pruneInbox(pool: pg.Pool, opts: { olderThanDays?: number; batchSize?: number } = {}) {
  const olderThanDays = opts.olderThanDays ?? 30;
  const batchSize = opts.batchSize ?? 5000;
  let total = 0;
  for (;;) {
    const res = await pool.query(
      `DELETE FROM webhook_inbox WHERE id IN (
         SELECT id FROM webhook_inbox
         WHERE status = 'done' AND processed_at < now() - make_interval(days => $1)
         LIMIT $2)`,
      [olderThanDays, batchSize],
    );
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batchSize) return total;
  }
}

// ---------- 5. Reconcile: pull what the provider says happened, ingest anything we missed ----------

/**
 * Run on a schedule (e.g. every 15 min over the last 24 h). `remote` lists events (or object states
 * converted to synthetic events) from the provider's API. Missed webhooks get ingested and processed
 * by the same handlers; the count is a health metric — alert if it is regularly > 0.
 */
export async function reconcile(pool: pg.Pool, remote: AsyncIterable<InboundEvent> | Iterable<InboundEvent>) {
  let missed = 0;
  for await (const e of remote) {
    if ((await ingest(pool, e, 'reconcile')).inserted) missed++;
  }
  return { missed };
}
