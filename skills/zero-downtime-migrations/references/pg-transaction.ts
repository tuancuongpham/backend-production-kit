// Postgres sessions that fail the call, not the process, when the server ends the connection; transactions that
// always end; and connections that never go back to the pool in a state the next caller would inherit. Vendored into
// each skill that imports it: edit shared/pg-transaction.ts, then run `npm run sync:shared`. `npm run validate` fails
// if a copy drifts.
import type pg from 'pg';

/**
 * Work done with a checked-out client. `lost` aborts if the server ends the connection meanwhile, or the session is
 * discarded. `discard` is for code that runs its own transaction statements: call it when the session is left in a
 * state nobody can vouch for (a ROLLBACK that failed), and the client is destroyed instead of going back to the pool.
 */
export type SessionWork<T> = (client: pg.PoolClient, lost: AbortSignal, discard: (reason: Error) => void) => Promise<T>;

/**
 * pg's error for a query that outlived the client-side `query_timeout`. pg stops waiting, but the server goes on
 * running the statement, inside its transaction: the connection is still busy, and its state unknown.
 */
const QUERY_TIMEOUT = 'Query read timeout';

/** `err`, or an error it wraps (`cause`), is pg giving up on a query the server may still be running. */
function isQueryTimeout(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (e.message === QUERY_TIMEOUT) return true;
  }
  return false;
}

/**
 * Runs `fn` with a client checked out of the pool.
 *
 * pg emits 'error' on a checked-out client whose connection dies between two queries: a failover,
 * pg_terminate_backend, or idle_in_transaction_session_timeout while the caller awaits something slow. With no
 * listener, that is an uncaught exception and the process exits with every in-flight request. Here it aborts `lost`
 * instead: the next query fails this call only, and the dead client is destroyed rather than returned to the pool.
 *
 * A client whose query timed out is destroyed too. Back in the pool it handed the next caller a connection still
 * running that statement: the caller timed out behind work that wasn't its own, and a transaction left open there was
 * committed by the next caller's COMMIT, with the writes of a request that had been told it failed. A destroyed
 * connection makes the server roll that transaction back.
 */
export async function withClient<T>(pool: pg.Pool, fn: SessionWork<T>): Promise<T> {
  const client = await pool.connect();
  const connection = new AbortController();
  const discard = (reason: Error) => {
    if (!connection.signal.aborted) connection.abort(reason);
  };
  client.on('error', discard);
  try {
    return await fn(client, connection.signal, discard);
  } catch (err) {
    if (isQueryTimeout(err)) discard(err as Error);
    throw err;
  } finally {
    client.off('error', discard);
    client.release(connection.signal.aborted ? (connection.signal.reason as Error) : undefined);
  }
}

export interface TransactionOptions {
  /** Replaces `BEGIN`, e.g. 'BEGIN READ ONLY' or 'BEGIN; SET LOCAL lock_timeout = 2000'. Never interpolate request data. */
  begin?: string;
}

/** `fn` between BEGIN and COMMIT, rolled back if anything fails, BEGIN and COMMIT included. */
export function withTransaction<T>(pool: pg.Pool, fn: SessionWork<T>, opts: TransactionOptions = {}): Promise<T> {
  return withClient(pool, async (client, lost, discard) => {
    try {
      await client.query(opts.begin ?? 'BEGIN');
      const result = await fn(client, lost, discard);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await rollback(client, err, discard);
      throw err;
    }
  });
}

/**
 * Ends a transaction that failed with `cause`, for code that runs its own BEGIN and COMMIT inside withClient. After
 * a query timeout there is no ROLLBACK: it would only queue behind the statement still running, and the connection
 * is destroyed instead, which rolls the transaction back on the server. A ROLLBACK that fails leaves the state
 * unknown: the connection is destroyed then too.
 */
export async function rollback(client: pg.PoolClient, cause: unknown, discard: (reason: Error) => void): Promise<void> {
  if (isQueryTimeout(cause)) return discard(cause as Error);
  await client.query('ROLLBACK').catch(discard);
}
