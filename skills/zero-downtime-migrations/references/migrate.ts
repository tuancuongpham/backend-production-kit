// Run schema changes against a live database:
//  - every DDL statement waits at most lock_timeout for its lock, then gives up and retries with backoff;
//  - CREATE / DROP / REINDEX … CONCURRENTLY run outside a transaction, and a failed concurrent build has its
//    INVALID index dropped instead of left behind;
//  - data backfills run in short, resumable batches.
// Table names, SET clauses and conditions are migration code, written by developers. Never pass request data.
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { callHook } from './hooks.ts';
import { withClient, withTransaction } from './pg-transaction.ts';

export interface Step {
  name: string;
  sql: string;
  /** For CREATE/DROP/REINDEX … CONCURRENTLY, which can't run in a transaction. Detected from the SQL when omitted. */
  concurrently?: boolean;
}

export interface StepOptions {
  /**
   * How long a statement may wait for its lock (default 2000 ms). While a DDL statement waits, every query that
   * arrives after it queues behind it, so this is the longest the app can stall.
   */
  lockTimeoutMs?: number;
  /** Cap on the statement itself once it has the lock (default 0 = none). Keep 0 for CONCURRENTLY builds. */
  statementTimeoutMs?: number;
  /** Attempts when the lock wasn't available (default 10). */
  attempts?: number;
  /** Pause before a retry: doubles from this (default 1000 ms) up to 30 s, with jitter. */
  baseDelayMs?: number;
  onRetry?: (step: Step, attempt: number, err: unknown) => unknown;
}

const LOCK_NOT_AVAILABLE = '55P03';
/** Errors after which the same statement can simply run again: deadlock, serialization failure, lock timeout. */
const TRANSIENT = new Set(['40P01', '40001', LOCK_NOT_AVAILABLE]);
const codeOf = (err: unknown) => (err as { code?: string }).code;
/** A setting: an integer of at least `min`. From an unset environment variable it is NaN, and a NaN attempt count retries forever. */
const ms = (n: number, name: string, min = 0) => {
  if (!Number.isInteger(n) || n < min) throw new RangeError(`${name} must be an integer of at least ${min}, got ${n}`);
  return n;
};
/** Doubling from `base` up to 30 s, with jitter. */
const backoff = (attempt: number, base: number) => {
  const delay = Math.min(30_000, base * 2 ** (attempt - 1));
  return delay / 2 + Math.random() * (delay / 2);
};

/** Runs one migration step; resolves with the number of attempts it took. */
export async function runStep(pool: pg.Pool, step: Step, o: StepOptions = {}): Promise<{ attempts: number }> {
  const lockTimeout = ms(o.lockTimeoutMs ?? 2000, 'lockTimeoutMs');
  const statementTimeout = ms(o.statementTimeoutMs ?? 0, 'statementTimeoutMs');
  const attempts = ms(o.attempts ?? 10, 'attempts', 1);
  const baseDelayMs = ms(o.baseDelayMs ?? 1000, 'baseDelayMs');
  const concurrently = step.concurrently ?? /\bCONCURRENTLY\b/i.test(step.sql);
  const run = concurrently
    ? // Can't run in a transaction: session settings instead, reset afterwards since the connection goes back to a pool.
      () =>
        withClient(pool, async (client) => {
          await client.query(`SET lock_timeout = ${lockTimeout}; SET statement_timeout = ${statementTimeout}`);
          const build = concurrentIndexBuild(step.sql);
          // An unnamed index gets a generated name, which this attempt can only find as an INVALID index that wasn't
          // there before it.
          const before = build && !build.name ? await invalidIndexes(client, build.table) : [];
          try {
            await client.query(step.sql);
          } catch (err) {
            if (build) await dropInvalidIndex(client, build, before);
            throw err;
          } finally {
            await client.query('RESET lock_timeout; RESET statement_timeout').catch(() => {});
          }
        })
    : () => withTransaction(pool, (tx) => tx.query(step.sql), { begin: `BEGIN; SET LOCAL lock_timeout = ${lockTimeout}; SET LOCAL statement_timeout = ${statementTimeout}` });
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return { attempts: attempt };
    } catch (err) {
      if (codeOf(err) !== LOCK_NOT_AVAILABLE || attempt >= attempts) throw err;
      callHook(o.onRetry, step, attempt, err);
      await sleep(backoff(attempt, baseDelayMs));
    }
  }
}

/** The index a CREATE INDEX CONCURRENTLY statement builds: its name (absent when Postgres generates one) and table. */
function concurrentIndexBuild(sql: string): { name?: string; table: string } | null {
  const m = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?!ON\b)("?[\w.]+"?)\s+)?ON\s+(?:ONLY\s+)?("?[\w.]+"?)/i.exec(sql);
  return m ? { name: m[1], table: m[2] } : null;
}

async function invalidIndexes(client: pg.PoolClient, table: string): Promise<string[]> {
  const { rows } = await client
    .query(`SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid = to_regclass($1) AND NOT indisvalid`, [table])
    .catch(() => ({ rows: [] as Array<{ name: string }> }));
  return rows.map((r) => r.name);
}

/**
 * A CREATE INDEX CONCURRENTLY that fails (a duplicate for a unique index, a lock or statement timeout, a
 * cancel) leaves its index behind, marked INVALID. Writes keep maintaining it, the planner never uses it, and
 * re-running the same statement fails on the name. Drop it so the step can be retried. An unnamed one is the INVALID
 * index on the table that wasn't there before the attempt: each retry would leave another (t_c_idx1, t_c_idx2…).
 */
async function dropInvalidIndex(client: pg.PoolClient, build: { name?: string; table: string }, before: string[]) {
  const left = build.name ? [build.name] : (await invalidIndexes(client, build.table)).filter((name) => !before.includes(name));
  for (const name of left) {
    const { rows } = await client
      .query(`SELECT NOT indisvalid AS invalid FROM pg_index WHERE indexrelid = to_regclass($1)`, [name])
      .catch(() => ({ rows: [] as Array<{ invalid: boolean }> }));
    if (rows[0]?.invalid) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`).catch(() => {});
  }
}

export interface BackfillOptions {
  table: string;
  /** e.g. `plan_v2 = upper(plan)` */
  set: string;
  /** Rows still to do, e.g. `plan_v2 IS NULL`. */
  where?: string;
  /** Integer primary key used to walk the table (default 'id'). */
  idColumn?: string;
  batchSize?: number; // default 1000
  /** Pause between batches, so autovacuum and replicas keep up (default 50 ms). */
  pauseMs?: number;
  /** Resume after this id (the lastId of an interrupted run). */
  afterId?: string | number | null;
  /** Retries of a batch that hit a deadlock with the app, a serialization failure or a lock timeout (default 5). */
  retries?: number;
  /** Progress, after each batch. Whatever it throws is dropped: to stop the backfill, abort `signal`. */
  onBatch?: (done: number, lastId: string) => unknown;
  /**
   * Abort to stop after the current batch (a deploy, the job's lease lost: pass a job's ctx.signal). backfill() then
   * rejects with the abort reason, carrying `lastId`, like any interrupted run.
   */
  signal?: AbortSignal;
}

/**
 * Update a large table in short batches walked by primary key. No transaction holds row locks for long, and
 * no single statement writes a gigabyte of WAL. A batch that loses a deadlock against the app (they update the
 * same rows in another order) is retried, not the whole backfill. Resumable: if it still gives up, the error
 * carries `lastId`; start again with `afterId: err.lastId`.
 */
export async function backfill(pool: pg.Pool, o: BackfillOptions): Promise<{ updated: number; batches: number; lastId: string | null }> {
  const id = o.idColumn ?? 'id';
  // batchSize 0 "finished" at once with nothing done; NaN retries retried a deadlocked batch forever.
  const batchSize = ms(o.batchSize ?? 1000, 'batchSize', 1);
  const retries = ms(o.retries ?? 5, 'retries');
  const pauseMs = ms(o.pauseMs ?? 50, 'pauseMs');
  let lastId = o.afterId == null ? null : String(o.afterId);
  let updated = 0;
  let batches = 0;
  const batch = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await pool.query(
          `WITH batch AS (
             SELECT ${id} FROM ${o.table}
             WHERE ($1::bigint IS NULL OR ${id} > $1) ${o.where ? `AND (${o.where})` : ''}
             ORDER BY ${id} LIMIT $2)
           UPDATE ${o.table} t SET ${o.set} FROM batch WHERE t.${id} = batch.${id}
           RETURNING t.${id} AS id`,
          [lastId, batchSize],
        );
      } catch (err) {
        // One statement per batch: a failed batch changed nothing, so running it again is safe.
        if (!TRANSIENT.has(codeOf(err) ?? '') || attempt > retries) throw Object.assign(err as Error, { lastId });
        await sleep(backoff(attempt, 100));
      }
    }
  };
  const stopIfAborted = () => {
    if (!o.signal?.aborted) return;
    const reason = o.signal.reason instanceof Error ? o.signal.reason : new Error('backfill stopped');
    throw Object.assign(reason, { lastId });
  };
  for (;;) {
    stopIfAborted();
    const { rows } = await batch();
    if (rows.length === 0) return { updated, batches, lastId };
    lastId = String(rows.reduce((max, r) => (BigInt(r.id) > BigInt(max) ? r.id : max), rows[0].id));
    updated += rows.length;
    batches++;
    callHook(o.onBatch, updated, lastId); // a progress logger that fails must not stop the backfill halfway
    if (rows.length < batchSize) return { updated, batches, lastId };
    await sleep(pauseMs, undefined, { signal: o.signal }).catch(() => {}); // an abort ends the pause at once
  }
}
