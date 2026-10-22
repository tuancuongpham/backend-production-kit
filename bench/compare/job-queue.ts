// Job queue claims at scale: do a claim, and a poll of an empty queue, stay cheap as finished and delayed
// jobs pile up? Each table holds 1,000,000 finished jobs and 100,000 jobs scheduled for tomorrow.
//   A. one table, index on run_at                          (what a first version usually looks like)
//   B. one 'pending' state, partial index (queue, priority, run_at)
//   C. shipped: delayed jobs wait as 'scheduled' and become 'available' when due (jobs.sql)
// Measured: the claim statement alone (BEGIN/ROLLBACK around it), first with nothing due, then with 10,000 due.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/job-queue.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { createWorker } from '../../skills/job-queue/references/jobs.ts';
import { latency, planSummary, save, selfTimed, table } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_jobs'), max: 4 });
await runSqlFile(pool, 'job-queue', 'jobs.sql');
const COLUMNS = `id bigserial PRIMARY KEY, queue text NOT NULL DEFAULT 'default', kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}', priority smallint NOT NULL DEFAULT 0, status text NOT NULL, run_at timestamptz NOT NULL`;
await pool.query(`
  CREATE TABLE jobs_naive (${COLUMNS});
  CREATE INDEX ON jobs_naive (run_at);
  CREATE TABLE jobs_pending (${COLUMNS});
  CREATE INDEX ON jobs_pending (queue, priority, run_at) WHERE status = 'pending';`);

console.log('loading 1,100,000 jobs per table…');
const tables: Array<[string, string, string]> = [
  ['jobs_naive', 'pending', 'pending'],
  ['jobs_pending', 'pending', 'pending'],
  ['jobs', 'scheduled', 'available'],
];
for (const [t, delayed] of tables) {
  await pool.query(`INSERT INTO ${t} (kind, status, run_at) SELECT 'email', 'done', now() - make_interval(secs => g) FROM generate_series(1, 1000000) g`);
  await pool.query(
    `INSERT INTO ${t} (kind, status, run_at) SELECT 'reminder', '${delayed}', now() + interval '1 day' + make_interval(secs => g) FROM generate_series(1, 100000) g`,
  );
  await pool.query(`VACUUM ANALYZE ${t}`);
}

const naiveClaim = (t: string) => `
  UPDATE ${t} SET status = 'running'
   WHERE id IN (SELECT id FROM ${t} WHERE status = 'pending' AND queue = 'default' AND run_at <= now()
                ORDER BY priority, run_at LIMIT 10 FOR UPDATE SKIP LOCKED)
   RETURNING id`;
const designs: Record<string, string> = {
  'A. one table, index on run_at': naiveClaim('jobs_naive'),
  'B. pending state, partial index (queue, priority, run_at)': naiveClaim('jobs_pending'),
  // createWorker's claim, word for word
  'C. shipped: scheduled → available': `
    UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_id = gen_random_uuid(),
           locked_until = now() + make_interval(secs => 60)
     WHERE id IN (SELECT id FROM jobs WHERE status = 'available' AND queue = 'default'
                  ORDER BY priority, run_at, id LIMIT 10 FOR UPDATE SKIP LOCKED)
     RETURNING id`,
};

const client = await pool.connect();
const inRolledBackTx = async <T>(work: () => Promise<T>) => {
  await client.query('BEGIN');
  try {
    return await work();
  } finally {
    await client.query('ROLLBACK'); // measure without consuming the jobs
  }
};
const timeClaim = (sql: string) =>
  inRolledBackTx(async () => {
    const t0 = performance.now();
    await client.query(sql);
    return performance.now() - t0;
  });

const rows: Array<Record<string, unknown>> = [];
for (const scenario of ['nothing due (idle poll)', '10,000 jobs due']) {
  if (scenario.startsWith('10,000')) {
    for (const [t, , ready] of tables) {
      await pool.query(
        `INSERT INTO ${t} (kind, status, priority, run_at) SELECT 'export', '${ready}', 5, now() - make_interval(secs => g / 100.0) FROM generate_series(1, 10000) g`,
      );
      await pool.query(`VACUUM ANALYZE ${t}`);
    }
  }
  for (const [design, sql] of Object.entries(designs)) {
    const lat = await selfTimed(design.startsWith('A') ? 30 : 200, () => timeClaim(sql), 5);
    const plan = planSummary((await inRolledBackTx(() => client.query(`EXPLAIN (FORMAT JSON) ${sql}`))).rows[0]['QUERY PLAN']);
    rows.push({ scenario, design, 'p50 ms': lat.p50, 'p95 ms': lat.p95, plan });
  }
}
client.release();
table(rows);

// The price of C: promotion and lease rescue, run by every instance about once a second.
const worker = createWorker({ pool, handlers: {} });
const maintenance = await latency(200, () => worker.maintain());
const extra = [{ 'C. maintain() with nothing to promote or rescue': `p50 ${maintenance.p50} ms, p95 ${maintenance.p95} ms` }];
table(extra);
save('job-queue', { finished: 1_000_000, delayed: 100_000, claims: rows, maintenance });
await pool.end();
