// Transactional outbox: write the event in the SAME transaction as the state change,
// publish it later from a relay, dedup on the consumer side.
import type pg from 'pg';
import { withTransaction } from './pg-transaction.ts';
import { pgJson, pgText } from './pg-values.ts';
import { withTimeout } from './with-timeout.ts';
import { runLoops } from './worker-loop.ts';

export interface OutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  headers?: Record<string, string>;
}

export interface OutboxMessage {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  headers: Record<string, string>;
}

/**
 * Call with the client of the business transaction — never a separate pool query. A NUL character in the event (a
 * customer's note) is stored as U+FFFD: Postgres can't hold it, and it must not roll back the business change.
 */
export async function enqueue(tx: pg.PoolClient, e: OutboxEvent): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, headers)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [pgText(e.aggregateType), pgText(e.aggregateId), pgText(e.eventType), pgJson(e.payload), pgJson(e.headers ?? {})],
  );
  return rows[0].id;
}

/**
 * Publish to your broker using msg.id as the message id so the broker can dedup too:
 *   NATS JetStream: js.publish(subject, data, { msgID: msg.id })
 *   Kafka:          key = aggregate_id (per-aggregate ordering), header 'message-id' = id
 *   Redis Streams:  XADD stream * id <msg.id> ...
 */
export type Publish = (msg: OutboxMessage) => Promise<void>;

export interface RelayOptions {
  pool: pg.Pool;
  publish: Publish;
  batchSize?: number; // default 100
  /**
   * A publish that hasn't settled after this long counts as failed (default 10 s). Without it, one hung
   * broker call keeps the relay's transaction and advisory lock forever: every relay instance skips and
   * the outbox silently stops. A timed-out publish may still land later — consumers dedup by message id.
   */
  publishTimeoutMs?: number;
}

export interface RelayRunOptions {
  /** Abort to stop; run() resolves once the batch in flight is done. */
  signal: AbortSignal;
  /** Pause when the outbox is empty, another instance holds the relay lock, or a run failed (default 1000 ms). */
  idleMs?: number;
  onError?: (err: unknown) => unknown;
}

// Arbitrary constant; one relay holds it at a time.
const RELAY_LOCK_KEY = 0x6f7574626f78; // "outbox"

/**
 * Publishes pending messages in commit order. A transaction-scoped advisory lock makes the relay single-active
 * across instances, which is what preserves ordering (with competing relays, message 2 could overtake message 1),
 * and the relay stops at the first failure for the same reason.
 */
export class OutboxRelay {
  readonly #pool: pg.Pool;
  readonly #publish: Publish;
  readonly #batchSize: number;
  readonly #publishTimeoutMs: number;

  constructor(o: RelayOptions) {
    if (typeof o.publish !== 'function') throw new TypeError('outbox relay: publish must be a function');
    this.#pool = o.pool;
    this.#publish = o.publish;
    this.#batchSize = o.batchSize ?? 100;
    this.#publishTimeoutMs = o.publishTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1) throw new RangeError('outbox relay: batchSize must be a positive integer');
    // Past what Node can schedule (about 24.8 days) the timeout runs after 1 ms: every publish would fail, the outbox stop.
    if (!(this.#publishTimeoutMs > 0) || this.#publishTimeoutMs > 2 ** 31 - 1) {
      throw new RangeError(`outbox relay: publishTimeoutMs must be a number of ms from 1 to ${2 ** 31 - 1}, got ${this.#publishTimeoutMs}`);
    }
  }

  /** One batch. Returns the number published; 0 also when another relay holds the lock. */
  relayOnce(): Promise<number> {
    return withTransaction(this.#pool, async (tx, lost) => {
      const lock = await tx.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [RELAY_LOCK_KEY]);
      if (!lock.rows[0].ok) return 0;
      const { rows } = await tx.query<OutboxMessage>(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, headers
         FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT $1`,
        [this.#batchSize],
      );
      const published: string[] = [];
      let failure: { id: string; error: string } | undefined;
      for (const msg of rows) {
        // The connection died while we were publishing (failover, idle_in_transaction_session_timeout): stop now.
        // The marks can't commit anyway, and every further publish would only be sent again on the next run.
        if (lost.aborted) throw lost.reason;
        try {
          await withTimeout(
            Promise.resolve().then(() => this.#publish(msg)), // a synchronous throw becomes a rejection
            this.#publishTimeoutMs,
            () => new Error(`publish timeout after ${this.#publishTimeoutMs} ms`),
          );
        } catch (err) {
          failure = { id: msg.id, error: pgText(String(err instanceof Error ? err.message : err).slice(0, 2000)) };
          break; // keep order: retry this message first next time
        }
        published.push(msg.id);
      }
      // One UPDATE for the batch, not one per message: 8× the relay throughput (docs/performance.md).
      // Same crash behaviour as before: marks only become durable at COMMIT either way, so a crash
      // mid-batch re-publishes the batch and consumers dedup by message id.
      if (published.length) {
        await tx.query(`UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = ANY($1::uuid[])`, [published]);
      }
      if (failure) {
        await tx.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [failure.id, failure.error]);
      }
      return published.length;
    });
  }

  /**
   * The relay process: batches back to back while there is a backlog, a pause of `idleMs` when there is none.
   * For lower latency, also call relayOnce() from a LISTEN outbox handler (outbox.sql has the NOTIFY trigger).
   */
  run(r: RelayRunOptions): Promise<void> {
    return runLoops({ tick: async () => (await this.relayOnce()) > 0, signal: r.signal, idleMs: r.idleMs, onError: r.onError });
  }
}

export const createRelay = (o: RelayOptions) => new OutboxRelay(o);

/**
 * Consumer side: apply a message at most once per consumer. The dedup row and the side effects
 * share a transaction, so a crash either applies both or neither. Duplicates from relay retries
 * or broker redelivery return 'duplicate' — ack them.
 */
export function consumeOnce(
  pool: pg.Pool,
  consumer: string,
  messageId: string,
  apply: (tx: pg.PoolClient) => Promise<void>,
): Promise<'applied' | 'duplicate'> {
  return withTransaction(pool, async (tx) => {
    const ins = await tx.query(`INSERT INTO processed_messages (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [consumer, messageId]);
    if (ins.rowCount === 0) return 'duplicate';
    await apply(tx);
    return 'applied';
  });
}

/**
 * Housekeeping: published rows are only needed for debugging/replay for a while. One DELETE on purpose: batches
 * through an index on published_at were measured 11× slower for a day of traffic, with no shorter statement, and the
 * index slowed every publish (docs/performance.md).
 */
export async function pruneOutbox(pool: pg.Pool, olderThanDays = 7) {
  const res = await pool.query(
    `DELETE FROM outbox WHERE published_at < now() - make_interval(days => $1)`,
    [olderThanDays],
  );
  return res.rowCount ?? 0;
}
