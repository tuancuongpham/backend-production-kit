// Run schema changes against a live database:
//  - every DDL statement waits at most lock_timeout for its lock, then gives up and retries with backoff;
//  - CREATE / DROP / REINDEX … CONCURRENTLY run outside a transaction, and a failed concurrent build has its
//    INVALID index dropped instead of left behind;
//  - data backfills run in short, resumable batches.
// Table names, SET clauses and conditions are migration code, written by developers. Never pass request data.
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';

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
  onRetry?: (step: Step, attempt: number, err: unknown) => void;
}

const LOCK_NOT_AVAILABLE = '55P03';
const ms = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

/** Runs one migration step; resolves with the number of attempts it took. */
export async function runStep(pool: pg.Pool, step: Step, o: StepOptions = {}): Promise<{ attempts: number }> {
  const lockTimeout = ms(o.lockTimeoutMs ?? 2000, 'lockTimeoutMs');
  const statementTimeout = ms(o.statementTimeoutMs ?? 0, 'statementTimeoutMs');
  const attempts = o.attempts ?? 10;
  const concurrently = step.concurrently ?? /\bCONCURRENTLY\b/i.test(step.sql);
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    // A connection dying between statements must fail this step, not crash the process.
    let lost: Error | undefined;
    const onLost = (err: Error) => {
      lost = err;
    };
    client.on('error', onLost);
    try {
      if (concurrently) {
        // Session settings, reset afterwards: the connection goes back to a pool.
        await client.query(`SET lock_timeout = ${lockTimeout}; SET statement_timeout = ${statementTimeout}`);
        try {
          await client.query(step.sql);
        } finally {
          await client.query('RESET lock_timeout; RESET statement_timeout').catch(() => {});
        }
      } else {
        await client.query(`BEGIN; SET LOCAL lock_timeout = ${lockTimeout}; SET LOCAL statement_timeout = ${statementTimeout}`);
        await client.query(step.sql);
        await client.query('COMMIT');
      }
      return { attempts: attempt };
    } catch (err) {
      if (concurrently) await dropInvalidIndex(client, step.sql);
      else await client.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code !== LOCK_NOT_AVAILABLE || attempt >= attempts) throw err;
      o.onRetry?.(step, attempt, err);
      const delay = Math.min(30_000, (o.baseDelayMs ?? 1000) * 2 ** (attempt - 1));
      await sleep(delay / 2 + Math.random() * (delay / 2));
    } finally {
      client.off('error', onLost);
      client.release(lost);
    }
  }
}

/**
 * A CREATE INDEX CONCURRENTLY that fails (a duplicate for a unique index, a lock or statement timeout, a
 * cancel) leaves its index behind, marked INVALID. Writes keep maintaining it, the planner never uses it, and
 * re-running the same statement fails on the name. Drop it so the step can be retried.
 */
async function dropInvalidIndex(client: pg.PoolClient, sql: string) {
  const m = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i.exec(sql);
  if (!m) return;
  const { rows } = await client
    .query(`SELECT NOT indisvalid AS invalid FROM pg_index WHERE indexrelid = to_regclass($1)`, [m[1]])
    .catch(() => ({ rows: [] as Array<{ invalid: boolean }> }));
  if (rows[0]?.invalid) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${m[1]}`).catch(() => {});
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
  onBatch?: (done: number, lastId: string) => void;
}

/**
 * Update a large table in short batches walked by primary key. No transaction holds row locks for long, and
 * no single statement writes a gigabyte of WAL. Resumable: on interruption, start again from `lastId`.
 */
export async function backfill(pool: pg.Pool, o: BackfillOptions): Promise<{ updated: number; batches: number; lastId: string | null }> {
  const id = o.idColumn ?? 'id';
  const batchSize = o.batchSize ?? 1000;
  let lastId = o.afterId == null ? null : String(o.afterId);
  let updated = 0;
  let batches = 0;
  for (;;) {
    const { rows } = await pool.query(
      `WITH batch AS (
         SELECT ${id} FROM ${o.table}
         WHERE ($1::bigint IS NULL OR ${id} > $1) ${o.where ? `AND (${o.where})` : ''}
         ORDER BY ${id} LIMIT $2)
       UPDATE ${o.table} t SET ${o.set} FROM batch WHERE t.${id} = batch.${id}
       RETURNING t.${id} AS id`,
      [lastId, batchSize],
    );
    if (rows.length === 0) return { updated, batches, lastId };
    lastId = String(rows.reduce((max, r) => (BigInt(r.id) > BigInt(max) ? r.id : max), rows[0].id));
    updated += rows.length;
    batches++;
    o.onBatch?.(updated, lastId);
    if (rows.length < batchSize) return { updated, batches, lastId };
    await sleep(o.pauseMs ?? 50);
  }
}
