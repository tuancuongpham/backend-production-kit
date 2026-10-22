// Transactional outbox: write the event in the SAME transaction as the state change,
// publish it later from a relay, dedup on the consumer side.
import type pg from 'pg';

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

/** Call with the client of the business transaction — never a separate pool query. */
export async function enqueue(tx: pg.PoolClient, e: OutboxEvent): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, headers)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(e.payload), JSON.stringify(e.headers ?? {})],
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

// Arbitrary constant; one relay holds it at a time.
const RELAY_LOCK_KEY = 0x6f7574626f78; // "outbox"

export function createRelay(o: RelayOptions) {
  const publishTimeoutMs = o.publishTimeoutMs ?? 10_000;

  async function publishWithTimeout(msg: OutboxMessage): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const call = Promise.resolve().then(() => o.publish(msg)); // a synchronous throw becomes a rejection
    call.catch(() => {}); // the race loser may reject later
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`publish timeout after ${publishTimeoutMs} ms`)), publishTimeoutMs);
    });
    try {
      await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Publishes pending messages in commit order. A transaction-scoped advisory lock makes this
   * single-active across instances, which is what preserves ordering (with competing relays,
   * message 2 could overtake message 1). Stops at the first failure for the same reason.
   * Returns the number published; 0 also when another relay holds the lock.
   */
  async function relayOnce(): Promise<number> {
    const client = await o.pool.connect();
    // pg emits 'error' on a checked-out client whose connection dies between queries: here, while a slow
    // publish runs and idle_in_transaction_session_timeout or a failover ends the session. Unheard, that
    // crashes the process; heard, this run fails, the batch is re-published next time, consumers dedup.
    let lost: Error | undefined;
    const onLost = (err: Error) => {
      lost = err;
    };
    client.on('error', onLost);
    try {
      await client.query('BEGIN');
      const lock = await client.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [RELAY_LOCK_KEY]);
      if (!lock.rows[0].ok) {
        await client.query('COMMIT');
        return 0;
      }
      const { rows } = await client.query<OutboxMessage>(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, headers
         FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT $1`,
        [o.batchSize ?? 100],
      );
      const published: string[] = [];
      let failure: { id: string; error: string } | undefined;
      for (const msg of rows) {
        // The connection died while we were publishing: stop now. The marks can't commit anyway, and every
        // further publish would only be sent again on the next run.
        if (lost) throw lost;
        try {
          await publishWithTimeout(msg);
        } catch (err) {
          failure = { id: msg.id, error: String(err instanceof Error ? err.message : err).slice(0, 2000) };
          break; // keep order: retry this message first next time
        }
        published.push(msg.id);
      }
      // One UPDATE for the batch, not one per message: 8× the relay throughput (docs/performance.md).
      // Same crash behaviour as before: marks only become durable at COMMIT either way, so a crash
      // mid-batch re-publishes the batch and consumers dedup by message id.
      if (published.length) {
        await client.query(`UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = ANY($1::uuid[])`, [published]);
      }
      if (failure) {
        await client.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [failure.id, failure.error]);
      }
      await client.query('COMMIT');
      return published.length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.off('error', onLost);
      client.release(lost);
    }
  }

  return { relayOnce };
}

/**
 * Consumer side: apply a message at most once per consumer. The dedup row and the side effects
 * share a transaction, so a crash either applies both or neither. Duplicates from relay retries
 * or broker redelivery return 'duplicate' — ack them.
 */
export async function consumeOnce(
  pool: pg.Pool,
  consumer: string,
  messageId: string,
  apply: (tx: pg.PoolClient) => Promise<void>,
): Promise<'applied' | 'duplicate'> {
  const client = await pool.connect();
  let lost: Error | undefined; // as in relayOnce: a connection dying mid-apply fails this call, not the process
  const onLost = (err: Error) => {
    lost = err;
  };
  client.on('error', onLost);
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO processed_messages (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [consumer, messageId],
    );
    if (ins.rowCount === 0) {
      await client.query('COMMIT');
      return 'duplicate';
    }
    await apply(client);
    await client.query('COMMIT');
    return 'applied';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.off('error', onLost);
    client.release(lost);
  }
}

/** Housekeeping: published rows are only needed for debugging/replay for a while. */
export async function pruneOutbox(pool: pg.Pool, olderThanDays = 7) {
  const res = await pool.query(
    `DELETE FROM outbox WHERE published_at < now() - make_interval(days => $1)`,
    [olderThanDays],
  );
  return res.rowCount ?? 0;
}
