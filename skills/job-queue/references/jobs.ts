// Background jobs on Postgres: enqueue inside the business transaction, claim with SKIP LOCKED, lease while
// running (heartbeats), retry with backoff, dead-letter, and fire recurring jobs exactly once per tick.
// Delivery is at-least-once: a handler must be safe to run twice, so key its effects by job.id.
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';

// ---------- 1. Enqueue ----------

export interface NewJob {
  kind: string;
  payload?: unknown;
  queue?: string; // default 'default'
  /** Lower runs first. Default 0. */
  priority?: number;
  /** Not before this time. Default now. */
  runAt?: Date;
  maxAttempts?: number; // default 8
  /** At most one scheduled, available or running job per (queue, dedupKey): duplicates are dropped. */
  dedupKey?: string;
}

/**
 * Pass the client of the business transaction: the job then exists if and only if the change committed (an
 * order and its "send confirmation" job). Returns the job id, or null when dedupKey dropped it as a duplicate.
 */
export async function enqueue(db: pg.Pool | pg.PoolClient, job: NewJob): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO jobs (queue, kind, payload, priority, run_at, status, max_attempts, dedup_key)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()),
             CASE WHEN COALESCE($5, now()) > now() THEN 'scheduled' ELSE 'available' END, $6, $7)
     ON CONFLICT (queue, dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('scheduled', 'available', 'running')
     DO NOTHING
     RETURNING id`,
    [job.queue ?? 'default', job.kind, JSON.stringify(job.payload ?? {}), job.priority ?? 0, job.runAt ?? null, job.maxAttempts ?? 8, job.dedupKey ?? null],
  );
  return rows[0]?.id ?? null;
}

// ---------- 2. Worker: claim, lease, run, retry, dead-letter ----------

export interface Job {
  id: string;
  queue: string;
  kind: string;
  payload: any;
  priority: number;
  /** Including this one. */
  attempts: number;
  max_attempts: number;
  run_at: Date;
}

/** `signal` aborts at the job timeout or when the lease is lost: pass it to every call that can take long. */
export type JobHandler = (job: Job, ctx: { signal: AbortSignal }) => Promise<void>;

export interface WorkerOptions {
  pool: pg.Pool;
  queue?: string; // default 'default'
  /** By job kind. A job of an unknown kind fails and is retried, so a consumer deployed late still gets it. */
  handlers: Record<string, JobHandler>;
  /** Jobs claimed per round trip; one loop runs them one after another. Default 1. */
  batchSize?: number;
  /** Lease per claim, renewed every leaseSec / 3 while the handler runs. A dead worker's jobs come back after it. Default 60. */
  leaseSec?: number;
  /** A handler still running after this long is aborted and the attempt counts as failed. Default 15 min. */
  timeoutMs?: number;
  baseDelayMs?: number; // retry backoff base, default 1 s
  maxDelayMs?: number; // default 1 h
  random?: () => number; // injectable for tests
  onDead?: (job: Pick<Job, 'id' | 'queue' | 'kind'>, error: unknown) => void; // alert here
}

export interface RunOptions {
  /** Independent claim → run loops (default 4); see webhook-ingestion for why not one loop with lanes. */
  loops?: number;
  /** Pause after an empty claim or an error, ms (default 1000). */
  idleMs?: number;
  /** How often to promote due jobs and rescue expired leases, ms (default 1000). */
  maintainEveryMs?: number;
  /** Abort to stop. run() resolves once every loop has finished the job it is running. */
  signal: AbortSignal;
  onError?: (err: unknown) => void;
}

/** Exponential backoff with "equal jitter": never ~0, never synchronized across jobs. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

type Claimed = Job & { lease_id: string };
type Outcome = 'done' | 'retry' | 'dead' | 'lost';

export function createWorker(o: WorkerOptions) {
  const queue = o.queue ?? 'default';
  const leaseSec = o.leaseSec ?? 60;
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  const base = o.baseDelayMs ?? 1_000;
  const max = o.maxDelayMs ?? 3_600_000;

  async function claim(): Promise<Claimed[]> {
    // Walks jobs_available_idx in (priority, run_at) order and stops after LIMIT rows. Only due jobs are
    // 'available', so the cost doesn't grow with delayed jobs or history.
    const { rows } = await o.pool.query<Claimed>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_id = gen_random_uuid(),
              locked_until = now() + make_interval(secs => $3)
        WHERE id IN (
          SELECT id FROM jobs WHERE status = 'available' AND queue = $1
          ORDER BY priority, run_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
        RETURNING id, queue, kind, payload, priority, attempts, max_attempts, run_at, lease_id`,
      [queue, o.batchSize ?? 1, leaseSec],
    );
    // RETURNING has no order.
    return rows.sort((a, b) => a.priority - b.priority || a.run_at.getTime() - b.run_at.getTime() || Number(a.id) - Number(b.id));
  }

  /** Push the lease forward. false: the job was rescued and someone else owns it now. */
  async function renew(job: Claimed): Promise<boolean> {
    const res = await o.pool.query(
      `UPDATE jobs SET locked_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_id = $2`,
      [job.id, job.lease_id, leaseSec],
    );
    return res.rowCount === 1;
  }

  async function execute(job: Claimed): Promise<Outcome> {
    const ac = new AbortController();
    const heartbeat = setInterval(() => {
      renew(job).then(
        (ok) => ok || ac.abort(new Error('lease lost: the job was rescued by another worker')),
        () => {}, // a missed beat is fine; the lease has 3 of them
      );
    }, Math.max(10, (leaseSec * 1000) / 3));
    const timer = setTimeout(() => ac.abort(new Error(`job timed out after ${timeoutMs} ms`)), timeoutMs);
    // Rejects when the signal aborts, so a handler that ignores it can't hold the loop forever. The catch keeps
    // a late abort (after the handler won the race) from becoming an unhandled rejection.
    const aborted = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true }));
    aborted.catch(() => {});
    try {
      const handler = o.handlers[job.kind];
      if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
      await Promise.race([handler(job, { signal: ac.signal }), aborted]);
    } catch (err) {
      clearInterval(heartbeat);
      return fail(job, err);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
    }
    // Only the current lease holder may complete: if this job was rescued meanwhile, the newer run owns it.
    const done = await o.pool.query(
      `UPDATE jobs SET status = 'done', finished_at = now(), lease_id = NULL, locked_until = NULL, last_error = NULL
        WHERE id = $1 AND lease_id = $2`,
      [job.id, job.lease_id],
    );
    return done.rowCount === 1 ? 'done' : 'lost';
  }

  async function fail(job: Claimed, err: unknown): Promise<Outcome> {
    const delay = backoffMs(job.attempts, base, max, o.random);
    const { rows } = await o.pool.query(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' WHEN $3 <= 0 THEN 'available' ELSE 'scheduled' END,
              run_at = now() + make_interval(secs => $3::float8 / 1000),
              finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
              lease_id = NULL, locked_until = NULL, last_error = $4
        WHERE id = $1 AND lease_id = $2
        RETURNING status`,
      [job.id, job.lease_id, delay, String(err instanceof Error ? err.message : err).slice(0, 2000)],
    );
    if (!rows[0]) return 'lost';
    if (rows[0].status === 'dead') {
      o.onDead?.(job, err);
      return 'dead';
    }
    return 'retry';
  }

  /** One claim → run tick. run() loops it; call it directly from tests or your own scheduler. */
  async function processOnce(): Promise<Outcome[]> {
    const jobs = await claim();
    const results: Outcome[] = [];
    for (let i = 0; i < jobs.length; i++) {
      // Later jobs of a batch waited behind earlier ones: renew first, and skip one that was rescued meanwhile.
      if (i > 0 && !(await renew(jobs[i]))) {
        results.push('lost');
        continue;
      }
      results.push(await execute(jobs[i]));
    }
    return results;
  }

  /**
   * Housekeeping, safe to run from every instance at once (SKIP LOCKED):
   * - rescue running jobs whose lease expired (the worker died, or froze), with backoff, or dead after max_attempts;
   * - promote scheduled jobs that are due (delayed jobs and retries) to available.
   */
  async function maintain(batch = 1000): Promise<{ rescued: number; promoted: number }> {
    const rescued = await o.pool.query(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'scheduled' END,
              run_at = now() + make_interval(secs => least($3::float8, $2::float8 * power(2, greatest(attempts - 1, 0))) * (0.5 + random() / 2) / 1000),
              finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
              lease_id = NULL, locked_until = NULL,
              last_error = 'lease expired: the worker stopped heartbeating (crashed, killed or frozen)'
        WHERE id IN (
          SELECT id FROM jobs WHERE status = 'running' AND locked_until < now()
          ORDER BY locked_until LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, queue, kind, status`,
      [batch, base, max],
    );
    for (const job of rescued.rows) if (job.status === 'dead') o.onDead?.(job, new Error('lease expired on the last attempt'));
    const promoted = await o.pool.query(
      `UPDATE jobs SET status = 'available'
        WHERE id IN (
          SELECT id FROM jobs WHERE status = 'scheduled' AND run_at <= now()
          ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
      [batch],
    );
    return { rescued: rescued.rowCount ?? 0, promoted: promoted.rowCount ?? 0 };
  }

  /**
   * The worker process: `loops` independent claim → run loops plus a maintenance loop. A delayed job starts
   * within about maintainEveryMs + idleMs of its run_at. Abort `signal` on SIGTERM and await the returned
   * promise in the shutdown hook: running jobs finish instead of waiting out their lease.
   */
  async function run(r: RunOptions): Promise<void> {
    const pause = (ms: number) => sleep(ms, undefined, { signal: r.signal }).catch(() => {}); // abort ends the nap
    const maintenance = async () => {
      while (!r.signal.aborted) {
        await maintain().catch((err) => r.onError?.(err));
        await pause(r.maintainEveryMs ?? 1000);
      }
    };
    const loop = async () => {
      while (!r.signal.aborted) {
        let worked = false;
        try {
          worked = (await processOnce()).length > 0;
        } catch (err) {
          r.onError?.(err);
        }
        if (!worked) await pause(r.idleMs ?? 1000);
      }
    };
    await Promise.all([maintenance(), ...Array.from({ length: Math.max(1, r.loops ?? 4) }, loop)]);
  }

  return { processOnce, maintain, run };
}

// ---------- 3. Recurring jobs ----------

export interface Schedule {
  /** Unique and stable: the schedule's state row is keyed by it. */
  name: string;
  kind: string;
  payload?: unknown;
  queue?: string;
  /** The next fire time strictly after `after`: every(ms) for intervals, a cron-expression parser for cron. */
  next: (after: Date) => Date;
}

export const every = (ms: number) => (after: Date) => new Date(after.getTime() + ms);

/**
 * Call tick() every few seconds from every instance. Each due fire is enqueued exactly once: the schedule
 * row is locked (SKIP LOCKED) and moved forward in the same transaction that enqueues the run. Fires missed
 * while everything was down collapse into one run. A run is dropped while the previous run of the same
 * schedule is still queued or running (dedup key), so slow jobs never pile up behind themselves.
 */
export function createScheduler(o: { pool: pg.Pool; schedules: Schedule[] }) {
  const byName = new Map(o.schedules.map((s) => [s.name, s]));
  let registered = false;

  async function tick(): Promise<string[]> {
    const client = await o.pool.connect();
    // pg emits 'error' on a checked-out client whose connection dies between queries (failover);
    // unheard, that crashes the process instead of failing this tick.
    let lost: Error | undefined;
    const onLost = (err: Error) => {
      lost = err;
    };
    client.on('error', onLost);
    try {
      if (!registered) {
        const now = new Date();
        await client.query(
          `INSERT INTO job_schedules (name, next_run_at) SELECT * FROM unnest($1::text[], $2::timestamptz[])
           ON CONFLICT (name) DO NOTHING`,
          [o.schedules.map((s) => s.name), o.schedules.map((s) => s.next(now))],
        );
        registered = true;
      }
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT name, next_run_at, now() AS db_now FROM job_schedules
          WHERE name = ANY($1) AND next_run_at <= now()
          FOR UPDATE SKIP LOCKED`,
        [[...byName.keys()]],
      );
      for (const r of rows) {
        const s = byName.get(r.name)!;
        await enqueue(client, { kind: s.kind, payload: s.payload, queue: s.queue, dedupKey: `schedule:${s.name}` });
        let next = s.next(r.next_run_at);
        while (next <= r.db_now) {
          const after = s.next(next);
          if (after <= next) throw new Error(`schedule "${s.name}": next() must move forward`);
          next = after; // skip the fires missed while nothing was ticking
        }
        await client.query(`UPDATE job_schedules SET next_run_at = $2 WHERE name = $1`, [r.name, next]);
      }
      await client.query('COMMIT');
      return rows.map((r) => r.name);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.off('error', onLost);
      client.release(lost);
    }
  }

  return { tick };
}

// ---------- 4. Operations: dead letters and retention ----------

/**
 * Put dead jobs back in the queue after a fix ships: by ids, queue and/or kind. Of several dead jobs sharing a
 * dedup key, only the newest comes back, and none whose key is already active again.
 */
export async function retryDead(pool: pg.Pool, filter: { ids?: string[]; queue?: string; kind?: string } = {}): Promise<number> {
  const res = await pool.query(
    `UPDATE jobs SET status = 'available', attempts = 0, run_at = now(), finished_at = NULL, last_error = NULL
      WHERE id IN (
        SELECT DISTINCT ON (queue, coalesce(dedup_key, id::text)) id
        FROM jobs d
        WHERE status = 'dead'
          AND ($1::bigint[] IS NULL OR id = ANY($1))
          AND ($2::text IS NULL OR queue = $2)
          AND ($3::text IS NULL OR kind = $3)
          AND (dedup_key IS NULL OR NOT EXISTS (
            SELECT 1 FROM jobs t WHERE t.queue = d.queue AND t.dedup_key = d.dedup_key
              AND t.status IN ('scheduled', 'available', 'running')))
        ORDER BY queue, coalesce(dedup_key, id::text), id DESC)`,
    [filter.ids ?? null, filter.queue ?? null, filter.kind ?? null],
  );
  return res.rowCount ?? 0;
}

/** Delete finished jobs older than the window, in batches. Dead jobs stay until a human looks at them. */
export async function pruneJobs(pool: pg.Pool, opts: { olderThanDays?: number; batchSize?: number } = {}): Promise<number> {
  const olderThanDays = opts.olderThanDays ?? 7;
  const batchSize = opts.batchSize ?? 5000;
  let total = 0;
  for (;;) {
    const res = await pool.query(
      `DELETE FROM jobs WHERE id IN (
         SELECT id FROM jobs WHERE status = 'done' AND finished_at < now() - make_interval(days => $1) LIMIT $2)`,
      [olderThanDays, batchSize],
    );
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batchSize) return total;
  }
}
