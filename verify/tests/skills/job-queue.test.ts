import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { sleep, waitFor } from '../support/wait.ts';
import { createScheduler, createWorker, enqueue, every, pruneJobs, retryDead } from '../../../skills/job-queue/references/jobs.ts';

let pool: pg.Pool;

const statusOf = async (id: string | null) => (await pool.query('SELECT status, attempts FROM jobs WHERE id = $1', [id])).rows[0];
const countOf = async (kind: string) => (await pool.query('SELECT count(*)::int AS n FROM jobs WHERE kind = $1', [kind])).rows[0].n;
/** Database time: delays are compared against the server's clock, not this process's. */
const dbNow = async () => ((await pool.query('SELECT now() AS t')).rows[0].t as Date).getTime();
const drain = async (worker: ReturnType<typeof createWorker>) => {
  const outcomes: string[] = [];
  for (let r = await worker.processOnce(); r.length > 0; r = await worker.processOnce()) outcomes.push(...r);
  return outcomes;
};

describe('job-queue', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_jobs'), max: 12 });
    await runSqlFile(pool, 'job-queue', 'jobs.sql');
    await runSqlFile(pool, 'job-queue', 'jobs.sql'); // idempotent
    await pool.query(`CREATE TABLE orders (id serial PRIMARY KEY, note text NOT NULL)`);
  });
  after(async () => pool?.end());
  beforeEach(async () => pool.query('TRUNCATE jobs, job_schedules, orders RESTART IDENTITY'));

  it('enqueue joins the business transaction: rolled back → no job, committed → exactly one', async () => {
    const tx = await pool.connect();
    await tx.query('BEGIN');
    await tx.query(`INSERT INTO orders (note) VALUES ('rolled back')`);
    await enqueue(tx, { kind: 'confirm-order', payload: { order: 1 } });
    await tx.query('ROLLBACK');
    await tx.query('BEGIN');
    await tx.query(`INSERT INTO orders (note) VALUES ('committed')`);
    const id = await enqueue(tx, { kind: 'confirm-order', payload: { order: 2 } });
    await tx.query('COMMIT');
    tx.release();
    const { rows } = await pool.query('SELECT id, status, payload FROM jobs');
    assert.deepEqual(rows, [{ id, status: 'available', payload: { order: 2 } }]);
  });

  it('runs due jobs by priority, then oldest first; a delayed job never runs early', async () => {
    const ran: string[] = [];
    const worker = createWorker({ pool, handlers: { note: async (job) => void ran.push(job.payload.n) } });
    await enqueue(pool, { kind: 'note', payload: { n: 'low-1' }, priority: 5 });
    await enqueue(pool, { kind: 'note', payload: { n: 'later' }, runAt: new Date((await dbNow()) + 400) });
    await enqueue(pool, { kind: 'note', payload: { n: 'high' }, priority: 0 });
    await enqueue(pool, { kind: 'note', payload: { n: 'low-2' }, priority: 5 });
    await drain(worker);
    assert.deepEqual(ran, ['high', 'low-1', 'low-2']);
    assert.deepEqual(await worker.maintain(), { rescued: 0, promoted: 0 }, 'not due yet');
    await sleep(600);
    assert.deepEqual(await worker.maintain(), { rescued: 0, promoted: 1 });
    await drain(worker);
    assert.deepEqual(ran, ['high', 'low-1', 'low-2', 'later']);
  });

  it('a failing job is retried with backoff, then dead-lettered; retryDead brings it back after the fix', async () => {
    let broken = true;
    let failures = 0;
    const dead: string[] = [];
    const handlers = {
      charge: async () => {
        if (broken) {
          failures++;
          throw new Error('provider down');
        }
      },
    };
    const worker = createWorker({ pool, baseDelayMs: 0, handlers, onDead: (job) => dead.push(job.id) });
    const id = await enqueue(pool, { kind: 'charge', maxAttempts: 3 });
    assert.deepEqual(await drain(worker), ['retry', 'retry', 'dead']);
    assert.equal(failures, 3);
    assert.deepEqual(dead, [id]);
    assert.deepEqual(await statusOf(id), { status: 'dead', attempts: 3 });

    // With a real base delay, the retry waits: attempt 1 with a 60 s base lands 30–60 s out.
    const patient = createWorker({ pool, baseDelayMs: 60_000, handlers });
    const other = await enqueue(pool, { kind: 'charge' });
    assert.deepEqual(await patient.processOnce(), ['retry']);
    const row = (await pool.query(`SELECT status, run_at > now() + interval '25 seconds' AS later FROM jobs WHERE id = $1`, [other])).rows[0];
    assert.deepEqual(row, { status: 'scheduled', later: true });

    broken = false;
    assert.equal(await retryDead(pool, { kind: 'charge' }), 1);
    assert.deepEqual(await drain(worker), ['done']);
    assert.deepEqual(await statusOf(id), { status: 'done', attempts: 1 });
  });

  it('a worker that dies after claiming: the job comes back when its lease expires and runs exactly once more', async () => {
    const id = await enqueue(pool, { kind: 'report' });
    // Worker A claims the job and dies: no heartbeat, no completion (the claim's own side effects).
    await pool.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_id = gen_random_uuid(),
              locked_until = now() + interval '300 milliseconds' WHERE id = $1`,
      [id],
    );
    let runs = 0;
    const worker = createWorker({ pool, baseDelayMs: 0, handlers: { report: async () => void runs++ } });
    assert.deepEqual(await worker.processOnce(), [], 'leased by A');
    assert.deepEqual(await worker.maintain(), { rescued: 0, promoted: 0 }, 'lease still valid');
    await sleep(400);
    assert.deepEqual(await worker.maintain(), { rescued: 1, promoted: 1 });
    assert.deepEqual(await worker.processOnce(), ['done']);
    assert.equal(runs, 1);
    assert.deepEqual(await statusOf(id), { status: 'done', attempts: 2 });
  });

  it('a worker frozen past its lease loses the job: it runs elsewhere, and the late finish is discarded', async () => {
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const ranBy: string[] = [];
    const workerA = createWorker({ pool, handlers: { report: async () => (ranBy.push('A'), gate) } });
    const workerB = createWorker({ pool, baseDelayMs: 0, handlers: { report: async () => void ranBy.push('B') } });
    const id = await enqueue(pool, { kind: 'report' });
    const a = workerA.processOnce();
    await waitFor(() => ranBy.includes('A'), 'A to start');
    // A freezes (GC pause, a laptop lid) long enough for its lease to lapse without a heartbeat.
    await pool.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    assert.deepEqual(await workerB.maintain(), { rescued: 1, promoted: 1 });
    assert.deepEqual(await workerB.processOnce(), ['done']);
    releaseA();
    assert.deepEqual(await a, ['lost'], "A's result is discarded: B's run owns the job");
    assert.deepEqual(ranBy, ['A', 'B']);
    assert.deepEqual(await statusOf(id), { status: 'done', attempts: 2 });
  });

  it('heartbeats keep a long job leased: maintenance never rescues it while it runs', async () => {
    let runs = 0;
    const worker = createWorker({
      pool,
      leaseSec: 0.6,
      handlers: {
        slow: async () => {
          runs++;
          await sleep(1500);
        },
      },
    });
    await enqueue(pool, { kind: 'slow' });
    const running = worker.processOnce();
    for (let i = 0; i < 6; i++) {
      await sleep(200);
      assert.equal((await worker.maintain()).rescued, 0, `rescued after ${(i + 1) * 200} ms`);
    }
    assert.deepEqual(await running, ['done']);
    assert.equal(runs, 1);
  });

  it('a job that overruns its timeout is failed and retried, even if the handler ignores the abort signal', async () => {
    const worker = createWorker({ pool, timeoutMs: 100, baseDelayMs: 60_000, handlers: { hang: () => new Promise(() => {}) } });
    const id = await enqueue(pool, { kind: 'hang' });
    const t0 = performance.now();
    assert.deepEqual(await worker.processOnce(), ['retry']);
    assert.ok(performance.now() - t0 < 1000);
    const row = (await pool.query(`SELECT status, last_error, run_at > now() + interval '25 seconds' AS later FROM jobs WHERE id = $1`, [id])).rows[0];
    assert.deepEqual(row, { status: 'scheduled', last_error: 'job timed out after 100 ms', later: true });
  });

  it('unique jobs: 10 concurrent enqueues with one key make one job; the key is free again once it has run', async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => enqueue(pool, { kind: 'reindex', dedupKey: 'doc-42' })));
    assert.equal(ids.filter(Boolean).length, 1);
    const worker = createWorker({ pool, handlers: { reindex: async () => {} } });
    assert.deepEqual(await drain(worker), ['done']);
    assert.ok(await enqueue(pool, { kind: 'reindex', dedupKey: 'doc-42' }), 'accepted again after the first finished');
    assert.equal(await countOf('reindex'), 2);
  });

  it('recurring jobs: three instances ticking at once enqueue a fire exactly once; missed fires collapse into one run', async () => {
    const schedules = [{ name: 'nightly-report', kind: 'report', next: every(60_000) }];
    const instances = [1, 2, 3].map(() => createScheduler({ pool, schedules }));
    await Promise.all(instances.map((s) => s.tick())); // registers the schedule, first fire a minute out
    assert.equal(await countOf('report'), 0);

    await pool.query(`UPDATE job_schedules SET next_run_at = now() - interval '1 second'`);
    const fired = await Promise.all(Array.from({ length: 30 }, (_, i) => instances[i % 3].tick()));
    assert.deepEqual(fired.flat(), ['nightly-report']);
    assert.equal(await countOf('report'), 1);

    // Due again while that run is still queued: the fire is dropped instead of piling up behind it.
    await pool.query(`UPDATE job_schedules SET next_run_at = now() - interval '1 second'`);
    assert.deepEqual(await instances[0].tick(), ['nightly-report']);
    assert.equal(await countOf('report'), 1);

    // Everything was down for three days: 4,320 missed fires become one run, and the schedule moves past now.
    await pool.query(`TRUNCATE jobs`);
    await pool.query(`UPDATE job_schedules SET next_run_at = now() - interval '3 days'`);
    assert.deepEqual(await instances[1].tick(), ['nightly-report']);
    assert.equal(await countOf('report'), 1);
    assert.equal((await pool.query(`SELECT next_run_at > now() AS future FROM job_schedules`)).rows[0].future, true);
    assert.deepEqual(await instances[2].tick(), [], 'nothing due until the next minute');
  });

  it('run(): loops drain the queue while maintenance promotes delayed jobs; stopping waits for running jobs', async () => {
    let active = 0;
    let maxActive = 0;
    let finished = 0;
    const worker = createWorker({
      pool,
      handlers: {
        work: async () => {
          maxActive = Math.max(maxActive, ++active);
          await sleep(50);
          active--;
          finished++;
        },
      },
    });
    const now = await dbNow();
    for (let i = 0; i < 12; i++) await enqueue(pool, { kind: 'work', runAt: i % 3 === 0 ? new Date(now + 200) : undefined });
    const stop = new AbortController();
    const running = worker.run({ loops: 4, idleMs: 20, maintainEveryMs: 50, signal: stop.signal });
    await waitFor(() => finished === 12, 'all 12 jobs, including the 4 delayed ones');
    assert.equal(maxActive, 4);

    for (let i = 0; i < 8; i++) await enqueue(pool, { kind: 'work' });
    await waitFor(() => active > 0, 'jobs to be running');
    stop.abort(); // a deploy's SIGTERM
    await running;
    const { rows } = await pool.query(`SELECT status FROM jobs WHERE status NOT IN ('done', 'available')`);
    assert.deepEqual(rows, [], 'nothing left running or half-done');
  });

  it('pruneJobs deletes old finished jobs in batches, and keeps dead and recent ones', async () => {
    await pool.query(`INSERT INTO jobs (kind, status, finished_at) SELECT 'old', 'done', now() - interval '30 days' FROM generate_series(1, 2500)`);
    await pool.query(`INSERT INTO jobs (kind, status, finished_at) VALUES ('recent', 'done', now()), ('broken', 'dead', now() - interval '30 days')`);
    assert.equal(await pruneJobs(pool, { olderThanDays: 7, batchSize: 1000 }), 2500);
    assert.deepEqual((await pool.query('SELECT kind FROM jobs ORDER BY kind')).rows.map((r) => r.kind), ['broken', 'recent']);
  });

  it('queue stats: depth per state, and how long the oldest due job has been waiting', async () => {
    await pool.query(
      `INSERT INTO jobs (kind, status, run_at) VALUES
         ('a', 'available', now() - interval '90 seconds'), ('a', 'available', now()),
         ('b', 'scheduled', now() + interval '1 hour'), ('c', 'dead', now())`,
    );
    const { rows } = await pool.query(`SELECT status, jobs::int, round(oldest_wait_sec) AS wait FROM job_queue_stats ORDER BY status`);
    assert.deepEqual(rows, [
      { status: 'available', jobs: 2, wait: 90 },
      { status: 'dead', jobs: 1, wait: null },
      { status: 'scheduled', jobs: 1, wait: null },
    ]);
  });
});
