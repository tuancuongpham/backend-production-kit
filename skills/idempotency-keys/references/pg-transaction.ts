// Postgres sessions that fail the call, not the process, when the server ends the connection, and transactions
// that always end. Vendored into each skill that imports it: edit shared/pg-transaction.ts, then run
// `npm run sync:shared`. `npm run validate` fails if a copy drifts.
import type pg from 'pg';

/** Work done with a checked-out client. `lost` aborts if the server ends the connection meanwhile. */
export type SessionWork<T> = (client: pg.PoolClient, lost: AbortSignal) => Promise<T>;

/**
 * Runs `fn` with a client checked out of the pool.
 *
 * pg emits 'error' on a checked-out client whose connection dies between two queries: a failover,
 * pg_terminate_backend, or idle_in_transaction_session_timeout while the caller awaits something slow. With no
 * listener, that is an uncaught exception and the process exits with every in-flight request. Here it aborts `lost`
 * instead: the next query fails this call only, and the dead client is destroyed rather than returned to the pool.
 */
export async function withClient<T>(pool: pg.Pool, fn: SessionWork<T>): Promise<T> {
  const client = await pool.connect();
  const connection = new AbortController();
  const onError = (err: Error) => connection.abort(err);
  client.on('error', onError);
  try {
    return await fn(client, connection.signal);
  } finally {
    client.off('error', onError);
    client.release(connection.signal.aborted ? (connection.signal.reason as Error) : undefined);
  }
}

export interface TransactionOptions {
  /** Replaces `BEGIN`, e.g. 'BEGIN READ ONLY' or 'BEGIN; SET LOCAL lock_timeout = 2000'. Never interpolate request data. */
  begin?: string;
}

/** `fn` between BEGIN and COMMIT, rolled back if it throws. */
export function withTransaction<T>(pool: pg.Pool, fn: SessionWork<T>, opts: TransactionOptions = {}): Promise<T> {
  return withClient(pool, async (client, lost) => {
    await client.query(opts.begin ?? 'BEGIN');
    try {
      const result = await fn(client, lost);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {}); // a dead connection rolls back on the server anyway
      throw err;
    }
  });
}
