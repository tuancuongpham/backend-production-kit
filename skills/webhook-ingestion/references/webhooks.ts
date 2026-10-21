// Webhook ingestion: verify → store once → process async with retries → dead-letter → replay → reconcile.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

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

export interface WorkerOptions {
  pool: pg.Pool;
  /** Keyed by `${provider}:${event_type}`, falling back to `${provider}:*`. */
  handlers: Record<string, Handler>;
  maxAttempts?: number; // default 8
  batchSize?: number; // default 10
  baseDelayMs?: number; // default 2_000
  maxDelayMs?: number; // default 1h
  stuckAfterSec?: number; // re-claim 'processing' rows older than this (worker crashed); default 300
  random?: () => number; // injectable for tests
  onDead?: (row: InboxRow, error: unknown) => void; // alert here
}

/** Exponential backoff with "equal jitter": never ~0, never synchronized across rows. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export function createInboxWorker(o: WorkerOptions) {
  const maxAttempts = o.maxAttempts ?? 8;
  const base = o.baseDelayMs ?? 2_000;
  const max = o.maxDelayMs ?? 3_600_000;

  async function claim(): Promise<InboxRow[]> {
    const { rows } = await o.pool.query<InboxRow>(
      `UPDATE webhook_inbox
         SET status = 'processing', locked_at = now(), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM webhook_inbox
         WHERE (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_at < now() - make_interval(secs => $2))
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
       RETURNING id, provider, event_id, event_type, payload, attempts, source`,
      [o.batchSize ?? 10, o.stuckAfterSec ?? 300],
    );
    return rows;
  }

  async function processRow(row: InboxRow): Promise<'done' | 'retry' | 'dead' | 'ignored'> {
    const handler = o.handlers[`${row.provider}:${row.event_type}`] ?? o.handlers[`${row.provider}:*`];
    const client = await o.pool.connect();
    try {
      if (!handler) {
        // Unknown event types are acknowledged, not retried forever. Keep the row for audit.
        await client.query(
          `UPDATE webhook_inbox SET status = 'done', processed_at = now(), locked_at = NULL, last_error = 'ignored: no handler' WHERE id = $1`,
          [row.id],
        );
        return 'ignored';
      }
      await client.query('BEGIN');
      await handler(row, client);
      await client.query(`UPDATE webhook_inbox SET status = 'done', processed_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1`, [row.id]);
      await client.query('COMMIT');
      return 'done';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const dead = row.attempts >= maxAttempts;
      const delay = backoffMs(row.attempts, base, max, o.random);
      await o.pool.query(
        `UPDATE webhook_inbox
           SET status = $2, locked_at = NULL, last_error = $3,
               next_attempt_at = now() + make_interval(secs => $4::float8 / 1000)
         WHERE id = $1`,
        [row.id, dead ? 'dead' : 'pending', String(err instanceof Error ? err.message : err).slice(0, 2000), delay],
      );
      if (dead) o.onDead?.(row, err);
      return dead ? 'dead' : 'retry';
    } finally {
      client.release();
    }
  }

  /** One polling tick. Run it on an interval (and/or on LISTEN/NOTIFY) from a worker process. */
  async function processOnce() {
    const rows = await claim();
    const results = [];
    for (const row of rows) results.push(await processRow(row));
    return results;
  }

  return { processOnce };
}

// ---------- 4. Replay: put dead (or any selected) events back in the queue ----------

export async function replay(pool: pg.Pool, filter: { ids?: string[]; provider?: string; eventType?: string; status?: 'dead' | 'done' }) {
  const res = await pool.query(
    `UPDATE webhook_inbox
       SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_at = NULL, last_error = NULL
     WHERE status = $1
       AND ($2::bigint[] IS NULL OR id = ANY($2))
       AND ($3::text IS NULL OR provider = $3)
       AND ($4::text IS NULL OR event_type = $4)`,
    [filter.status ?? 'dead', filter.ids ?? null, filter.provider ?? null, filter.eventType ?? null],
  );
  return res.rowCount ?? 0;
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
