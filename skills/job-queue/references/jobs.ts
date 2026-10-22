// Background jobs on Postgres: enqueue inside the business transaction, claim with SKIP LOCKED, lease while
// running (heartbeats), retry with backoff, dead-letter, and fire recurring jobs exactly once per tick.
// Delivery is at-least-once: a handler must be safe to run twice, so key its effects by job.id.
import type pg from 'pg';
import { callHook } from './hooks.ts';
import { withTransaction } from './pg-transaction.ts';
import { pgJson, pgText } from './pg-values.ts';
import { runLoops } from './worker-loop.ts';

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
  // A run time parsed from user input ("remind me at …") can be an Invalid Date: say so, not with a database error.
  if (job.runAt !== undefined && !(job.runAt instanceof Date && Number.isFinite(job.runAt.getTime()))) {
    throw new RangeError(`enqueue: runAt must be a valid Date, got ${String(job.runAt)}`);
  }
  // The columns are smallint and int: a value past them would be a database error, not one naming the field.
  if (job.priority !== undefined && !(Number.isInteger(job.priority) && job.priority >= -32_768 && job.priority <= 32_767)) {
    throw new RangeError(`enqueue: priority must be an integer from -32768 to 32767, got ${job.priority}`);
  }
  if (job.maxAttempts !== undefined && !(Number.isInteger(job.maxAttempts) && job.maxAttempts >= 1 && job.maxAttempts <= 2 ** 31 - 1)) {
    throw new RangeError(`enqueue: maxAttempts must be a positive integer, got ${job.maxAttempts}`);
  }
  const { rows } = await db.query(
    `INSERT INTO jobs (queue, kind, payload, priority, run_at, status, max_attempts, dedup_key)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()),
             CASE WHEN COALESCE($5, now()) > now() THEN 'scheduled' ELSE 'available' END, $6, $7)
     ON CONFLICT (queue, dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('scheduled', 'available', 'running')
     DO NOTHING
     RETURNING id`,
    // A NUL character from user data in the payload or dedup key is stored as U+FFFD (Postgres can't hold it).
    [job.queue ?? 'default', job.kind, pgJson(job.payload ?? {}), job.priority ?? 0, job.runAt ?? null, job.maxAttempts ?? 8, pgText(job.dedupKey ?? null)],
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
  /** Lease per claim, renewed every leaseSec / 3 for every job of the batch. A dead worker's jobs come back after it. Default 60. */
  leaseSec?: number;
  /** A handler still running after this long is aborted and the attempt counts as failed. Default 15 min. */
  timeoutMs?: number;
  baseDelayMs?: number; // retry backoff base, default 1 s
  maxDelayMs?: number; // default 1 h
  random?: () => number; // injectable for tests
  onDead?: (job: Pick<Job, 'id' | 'queue' | 'kind'>, error: unknown) => unknown; // alert here
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
  onError?: (err: unknown) => unknown;
}

/** Exponential backoff with "equal jitter": never ~0, never synchronized across jobs. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

type Claimed = Job & { lease_id: string };

/** done · retry · dead · lost (rescued by another worker meanwhile) · released (handed back unstarted on stop). */
export type Outcome = 'done' | 'retry' | 'dead' | 'lost' | 'released';

const positive = (v: number, name: string, integer = true) => {
  if (!(v > 0) || (integer && !Number.isInteger(v))) throw new RangeError(`job worker: ${name} must be a positive ${integer ? 'integer' : 'number'}, got ${v}`);
  return v;
};
/** A NaN delay (an unset environment variable) fails every retry, and with it the rescue of expired leases. */
const delay = (v: number, name: string) => {
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`job worker: ${name} must be a number of ms, 0 or more, got ${v}`);
  return v;
};

export class JobWorker {
  readonly #pool: pg.Pool;
  readonly #queue: string;
  readonly #handlers: Record<string, JobHandler>;
  readonly #batchSize: number;
  readonly #leaseSec: number;
  readonly #timeoutMs: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #random: () => number;
  readonly #onDead?: WorkerOptions['onDead'];

  constructor(o: WorkerOptions) {
    this.#pool = o.pool;
    this.#queue = o.queue ?? 'default';
    this.#handlers = o.handlers;
    this.#batchSize = positive(o.batchSize ?? 1, 'batchSize');
    this.#leaseSec = positive(o.leaseSec ?? 60, 'leaseSec', false);
    this.#timeoutMs = positive(o.timeoutMs ?? 15 * 60_000, 'timeoutMs', false);
    this.#baseDelayMs = delay(o.baseDelayMs ?? 1_000, 'baseDelayMs');
    this.#maxDelayMs = delay(o.maxDelayMs ?? 3_600_000, 'maxDelayMs');
    this.#random = o.random ?? Math.random;
    this.#onDead = o.onDead;
  }

  /**
   * One claim → run tick; run() loops it. The jobs of a batch run one after another, and one heartbeat renews the
   * lease of every job the batch still holds, the waiting ones too: a job queued behind a slow one never expires
   * and burns an attempt without running. When `signal` aborts (run() passes its own), the tick ends after the
   * running job and hands the unstarted ones back, their attempt unspent.
   */
  async processOnce(signal?: AbortSignal): Promise<Outcome[]> {
    const batch = await this.#claim();
    if (batch.length === 0) return [];
    const held = new Map(batch.map((j) => [j.id, j]));
    let running: { id: string; abort: (reason: Error) => void } | null = null;
    const heartbeat = setInterval(() => {
      this.#renew([...held.values()]).then(
        (kept) => {
          for (const id of [...held.keys()]) {
            if (kept.has(id)) continue;
            held.delete(id);
            if (running?.id === id) running.abort(new Error('lease lost: the job was rescued by another worker'));
          }
        },
        () => {}, // a missed beat is fine; the lease outlasts three of them
      );
    }, Math.max(10, (this.#leaseSec * 1000) / 3));
    const results: Outcome[] = [];
    try {
      for (const job of batch) {
        if (signal?.aborted) {
          results.push(...(await this.#release([...held.values()])));
          break;
        }
        if (!held.has(job.id)) {
          results.push('lost');
          continue;
        }
        const ac = new AbortController();
        running = { id: job.id, abort: (reason) => ac.abort(reason) };
        results.push(await this.#execute(job, ac));
        running = null;
        held.delete(job.id);
      }
    } finally {
      clearInterval(heartbeat);
    }
    return results;
  }

  /**
   * Housekeeping, safe to run from every instance at once (SKIP LOCKED):
   * - rescue running jobs whose lease expired (the worker died, or froze), with backoff, or dead after max_attempts;
   * - promote scheduled jobs that are due (delayed jobs and retries) to available.
   */
  async maintain(batch = 1000): Promise<{ rescued: number; promoted: number }> {
    const rescued = await this.#pool.query(
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
      [batch, this.#baseDelayMs, this.#maxDelayMs],
    );
    for (const job of rescued.rows) if (job.status === 'dead') callHook(this.#onDead, job, new Error('lease expired on the last attempt'));
    const promoted = await this.#pool.query(
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
   * promise in the shutdown hook: running jobs finish, claimed ones go back to the queue at once.
   */
  async run(r: RunOptions): Promise<void> {
    await Promise.all([
      runLoops({ tick: async () => (await this.maintain(), false), signal: r.signal, idleMs: r.maintainEveryMs ?? 1000, onError: r.onError }),
      runLoops({ tick: async () => (await this.processOnce(r.signal)).length > 0, signal: r.signal, loops: r.loops ?? 4, idleMs: r.idleMs, onError: r.onError }),
    ]);
  }

  async #claim(): Promise<Claimed[]> {
    // Walks jobs_available_idx in (priority, run_at) order and stops after LIMIT rows. Only due jobs are
    // 'available', so the cost doesn't grow with delayed jobs or history.
    const { rows } = await this.#pool.query<Claimed>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_id = gen_random_uuid(),
              locked_until = now() + make_interval(secs => $3)
        WHERE id IN (
          SELECT id FROM jobs WHERE status = 'available' AND queue = $1
          ORDER BY priority, run_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
        RETURNING id, queue, kind, payload, priority, attempts, max_attempts, run_at, lease_id`,
      [this.#queue, this.#batchSize, this.#leaseSec],
    );
    // RETURNING has no order.
    return rows.sort((a, b) => a.priority - b.priority || a.run_at.getTime() - b.run_at.getTime() || Number(a.id) - Number(b.id));
  }

  /** Push the leases forward; returns the ids still ours (the others were rescued by another worker). */
  async #renew(jobs: Claimed[]): Promise<Set<string>> {
    if (jobs.length === 0) return new Set();
    // Lease ids are unique per claim, so matching both arrays matches each job with its own lease.
    const { rows } = await this.#pool.query(
      `UPDATE jobs SET locked_until = now() + make_interval(secs => $3)
        WHERE id = ANY($1::bigint[]) AND lease_id = ANY($2::uuid[]) RETURNING id`,
      [jobs.map((j) => j.id), jobs.map((j) => j.lease_id), this.#leaseSec],
    );
    return new Set(rows.map((r) => String(r.id)));
  }

  /** Hand claimed jobs back unstarted: available again at once, and the claim's attempt is not counted. */
  async #release(jobs: Claimed[]): Promise<Outcome[]> {
    if (jobs.length === 0) return [];
    const { rows } = await this.#pool.query(
      `UPDATE jobs SET status = 'available', attempts = attempts - 1, lease_id = NULL, locked_until = NULL
        WHERE id = ANY($1::bigint[]) AND lease_id = ANY($2::uuid[]) RETURNING id`,
      [jobs.map((j) => j.id), jobs.map((j) => j.lease_id)],
    );
    const released = new Set(rows.map((r) => String(r.id)));
    return jobs.map((j) => (released.has(j.id) ? 'released' : 'lost'));
  }

  async #execute(job: Claimed, ac: AbortController): Promise<Outcome> {
    const timer = setTimeout(() => ac.abort(new Error(`job timed out after ${this.#timeoutMs} ms`)), this.#timeoutMs);
    // Rejects when the signal aborts, so a handler that ignores it can't hold the loop forever. The catch keeps
    // a late abort (after the handler won the race) from becoming an unhandled rejection.
    const aborted = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason as Error), { once: true }));
    aborted.catch(() => {});
    try {
      const handler = this.#handlers[job.kind];
      if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
      await Promise.race([handler(job, { signal: ac.signal }), aborted]);
    } catch (err) {
      return await this.#fail(job, err);
    } finally {
      clearTimeout(timer);
    }
    // Only the current lease holder may complete: if this job was rescued meanwhile, the newer run owns it.
    const done = await this.#pool.query(
      `UPDATE jobs SET status = 'done', finished_at = now(), lease_id = NULL, locked_until = NULL, last_error = NULL
        WHERE id = $1 AND lease_id = $2`,
      [job.id, job.lease_id],
    );
    return done.rowCount === 1 ? 'done' : 'lost';
  }

  async #fail(job: Claimed, err: unknown): Promise<Outcome> {
    const delay = backoffMs(job.attempts, this.#baseDelayMs, this.#maxDelayMs, this.#random);
    const { rows } = await this.#pool.query(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' WHEN $3 <= 0 THEN 'available' ELSE 'scheduled' END,
              run_at = now() + make_interval(secs => $3::float8 / 1000),
              finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
              lease_id = NULL, locked_until = NULL, last_error = $4
        WHERE id = $1 AND lease_id = $2
        RETURNING status`,
      [job.id, job.lease_id, delay, pgText(String(err instanceof Error ? err.message : err).slice(0, 2000))],
    );
    if (!rows[0]) return 'lost';
    if (rows[0].status === 'dead') {
      callHook(this.#onDead, job, err); // an alert that fails can't undo the dead letter
      return 'dead';
    }
    return 'retry';
  }
}

export const createWorker = (o: WorkerOptions) => new JobWorker(o);

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

/** The schedule's next fire strictly after `after`, checked: next() is the app's code (often a cron parser). */
function nextFire(s: Schedule, after: Date): Date {
  const next = s.next(after);
  if (!(next instanceof Date) || !Number.isFinite(next.getTime()) || next <= after) {
    throw new Error(`schedule "${s.name}": next(${after.toISOString()}) returned ${String(next)}, not a date after it`);
  }
  return next;
}

/** The first fire after `last` that is still ahead of `now`: the fires missed while nothing was ticking are skipped. */
function followingFire(s: Schedule, last: Date, now: Date): Date {
  let next = nextFire(s, last);
  while (next <= now) next = nextFire(s, next);
  return next;
}

export interface SchedulerOptions {
  pool: pg.Pool;
  schedules: Schedule[];
  /**
   * A schedule that can't be registered or moved forward: its next() threw, or gave no date after the one it was
   * given (an impossible cron expression such as February 31). It doesn't fire, the others still do, and it is
   * reported on every tick until it is fixed. Without onError, tick() rejects once the others are done.
   */
  onError?: (err: unknown, schedule: string) => unknown;
}

/**
 * Call tick() every few seconds from every instance. Each due fire is enqueued exactly once: the schedule
 * row is locked (SKIP LOCKED) and moved forward in the same transaction that enqueues the run. Fires missed
 * while everything was down collapse into one run. A run is dropped while the previous run of the same
 * schedule is still queued or running (dedup key), so slow jobs never pile up behind themselves.
 */
export class Scheduler {
  readonly #pool: pg.Pool;
  readonly #schedules: Map<string, Schedule>;
  readonly #onError?: SchedulerOptions['onError'];
  readonly #registered = new Set<string>();

  constructor(o: SchedulerOptions) {
    this.#pool = o.pool;
    this.#schedules = new Map(o.schedules.map((s) => [s.name, s]));
    this.#onError = o.onError;
    if (this.#schedules.size !== o.schedules.length) throw new Error('scheduler: schedule names must be unique (each keys its own state row)');
  }

  /** Enqueues the due fires; returns the names of the schedules that fired. */
  async tick(): Promise<string[]> {
    const failed: Array<{ name: string; err: unknown }> = [];
    await this.#register(failed);
    const fired = await withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query(
        `SELECT name, next_run_at, now() AS db_now FROM job_schedules
          WHERE name = ANY($1) AND next_run_at <= now()
          FOR UPDATE SKIP LOCKED`,
        [[...this.#registered]],
      );
      const names: string[] = [];
      for (const r of rows) {
        const s = this.#schedules.get(r.name)!;
        let next: Date;
        try {
          next = followingFire(s, r.next_run_at, r.db_now);
        } catch (err) {
          failed.push({ name: s.name, err }); // its own failure: it stays due, and the others go on
          continue;
        }
        await enqueue(tx, { kind: s.kind, payload: s.payload, queue: s.queue, dedupKey: `schedule:${s.name}` });
        await tx.query(`UPDATE job_schedules SET next_run_at = $2 WHERE name = $1`, [r.name, next]);
        names.push(r.name);
      }
      return names;
    });
    if (failed.length) {
      if (!this.#onError) throw new AggregateError(failed.map((f) => f.err), `scheduler: ${failed.map((f) => f.name).join(', ')} can't be scheduled`);
      for (const { name, err } of failed) callHook(this.#onError, err, name);
    }
    return fired;
  }

  /** Creates the state row of every schedule not registered yet. One that can't say when it first fires waits. */
  async #register(failed: Array<{ name: string; err: unknown }>) {
    const now = new Date();
    const rows: Array<[string, Date]> = [];
    for (const s of this.#schedules.values()) {
      if (this.#registered.has(s.name)) continue;
      try {
        rows.push([s.name, nextFire(s, now)]);
      } catch (err) {
        failed.push({ name: s.name, err });
      }
    }
    if (rows.length === 0) return;
    await this.#pool.query(
      `INSERT INTO job_schedules (name, next_run_at) SELECT * FROM unnest($1::text[], $2::timestamptz[])
       ON CONFLICT (name) DO NOTHING`,
      [rows.map(([name]) => name), rows.map(([, next]) => next)],
    );
    for (const [name] of rows) this.#registered.add(name);
  }
}

export const createScheduler = (o: SchedulerOptions) => new Scheduler(o);

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
