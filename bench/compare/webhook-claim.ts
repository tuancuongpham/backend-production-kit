// Webhook inbox at scale.
//   claim:  v0.2.0 claim (one `pending OR stuck` filter, ORDER BY next_attempt_at) vs v0.3.0 claim (two
//           branches, each walking its partial index in order) as the due backlog grows. 300,000 'done'
//           rows and 20 stuck rows throughout. Only the claim statement is timed (BEGIN/ROLLBACK around it).
//   drain:  how to spend 8 lanes when handlers are uniform (5 ms) or heavy-tailed (every 20th takes 200 ms)
//   sweep:  concurrency 1–32 on one loop, batch 50, pool of 20 connections
// Run inside the Docker network:  npm run bench:docker -- bench/compare/webhook-claim.ts
import pg from 'pg';
import { freshDatabase, runSqlFile, sleep } from '../../verify/tests/helpers.ts';
import { createInboxWorker, type InboxRow } from '../../skills/webhook-ingestion/references/webhooks.ts';
import { planSummary, save, selfTimed, table } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_claim'), max: 20 });
await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
await pool.query(`
  INSERT INTO webhook_inbox (provider, event_id, event_type, payload, status, processed_at, received_at)
  SELECT 'stripe', 'done_' || g, 'payment.succeeded', '{}', 'done', now() - interval '1 day', now() - interval '1 day'
  FROM generate_series(1, 300000) g;
  INSERT INTO webhook_inbox (provider, event_id, event_type, payload, status, attempts, locked_at)
  SELECT 'stripe', 'stuck_' || g, 'payment.succeeded', '{}', 'processing', 1, now() - interval '1 hour' FROM generate_series(1, 20) g;`);
const addPending = (n: number, prefix: string) =>
  pool.query(
    `INSERT INTO webhook_inbox (provider, event_id, event_type, payload, next_attempt_at)
     SELECT 'stripe', $2 || g, 'payment.succeeded', '{}', now() - interval '1 minute' FROM generate_series(1, $1::int) g`,
    [n, prefix],
  );

const SET = `UPDATE webhook_inbox SET status = 'processing', locked_at = now(), attempts = attempts + 1`;
const claims: Record<string, string> = {
  'v0.2.0: pending OR stuck': `${SET}
    WHERE id IN (SELECT id FROM webhook_inbox
      WHERE (status = 'pending' AND next_attempt_at <= now())
         OR (status = 'processing' AND locked_at < now() - make_interval(secs => $2))
      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING id`,
  'v0.3.0: stuck branch + due branch': `${SET}
    WHERE id IN (
      SELECT id FROM (SELECT id FROM webhook_inbox
        WHERE status = 'processing' AND locked_at < now() - make_interval(secs => $2)
        ORDER BY locked_at LIMIT $1 FOR UPDATE SKIP LOCKED) stuck
      UNION ALL
      SELECT id FROM (SELECT id FROM webhook_inbox
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED) due
      LIMIT $1)
    RETURNING id`,
};

const client = await pool.connect();
const claimOnce = async (sql: string) => {
  await client.query('BEGIN');
  try {
    const t0 = performance.now();
    const r = await client.query(sql, [10, 300]);
    if (r.rowCount !== 10) throw new Error(`claimed ${r.rowCount} rows`);
    return performance.now() - t0;
  } finally {
    await client.query('ROLLBACK'); // measure the claim without consuming rows
  }
};
const claimRows: Array<Record<string, unknown>> = [];
let pending = 0;
for (const backlog of [2_000, 50_000, 200_000]) {
  await addPending(backlog - pending, `p${backlog}_`);
  pending = backlog;
  await pool.query(`VACUUM ANALYZE webhook_inbox`);
  for (const [name, sql] of Object.entries(claims)) {
    const lat = await selfTimed(backlog >= 200_000 ? 50 : 200, () => claimOnce(sql), 10);
    await client.query('BEGIN');
    const plan = planSummary((await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, [10, 300])).rows[0]['QUERY PLAN']);
    await client.query('ROLLBACK');
    claimRows.push({ 'due backlog': backlog.toLocaleString('en-US'), claim: name, 'p50 ms': lat.p50, 'p95 ms': lat.p95, plan });
  }
}
client.release();
table(claimRows);

const drainAll = async (loops: number, opts: { batchSize: number; concurrency: number; slowEvery?: number }) => {
  const handler = (row: InboxRow) => sleep(opts.slowEvery && Number(row.event_id.split('_').at(-1)) % opts.slowEvery === 0 ? 200 : 5);
  const worker = createInboxWorker({ pool, batchSize: opts.batchSize, concurrency: opts.concurrency, handlers: { 'stripe:payment.succeeded': handler } });
  const t0 = performance.now();
  await Promise.all(Array.from({ length: loops }, async () => { while ((await worker.processOnce()).length > 0); }));
  return Math.round(performance.now() - t0);
};

await pool.query(`DELETE FROM webhook_inbox WHERE status <> 'done'`);
await pool.query(`VACUUM ANALYZE webhook_inbox`);
const layouts = [
  { layout: '1 loop, batch 50, concurrency 8', loops: 1, batchSize: 50, concurrency: 8 },
  { layout: '1 loop, batch 8, concurrency 8', loops: 1, batchSize: 8, concurrency: 8 },
  { layout: '8 loops, batch 1, concurrency 1', loops: 8, batchSize: 1, concurrency: 1 },
  { layout: '8 loops, batch 4, concurrency 1', loops: 8, batchSize: 4, concurrency: 1 },
];
const tails = [['uniform 5 ms', undefined], ['every 20th 200 ms', 20]] as const;
const drainRows: Array<Record<string, unknown>> = [];
let batchNo = 0;
for (const { layout, loops, batchSize, concurrency } of layouts) {
  const row: Record<string, unknown> = { layout };
  for (const [label, slowEvery] of tails) {
    await addPending(200, `d${batchNo++}_`);
    row[`${label}: drain 200, ms`] = await drainAll(loops, { batchSize, concurrency, slowEvery });
  }
  drainRows.push(row);
}
// The shipped runner with the winning layout: worker.run({ loops: 8 }), batch 4. Timed until the inbox is empty.
{
  const row: Record<string, unknown> = { layout: 'shipped run({ loops: 8 }), batch 4' };
  for (const [label, slowEvery] of tails) {
    await addPending(200, `d${batchNo++}_`);
    const handler = (r: InboxRow) => sleep(slowEvery && Number(r.event_id.split('_').at(-1)) % slowEvery === 0 ? 200 : 5);
    const worker = createInboxWorker({ pool, batchSize: 4, handlers: { 'stripe:payment.succeeded': handler } });
    const stop = new AbortController();
    const t0 = performance.now();
    const running = worker.run({ loops: 8, idleMs: 5, signal: stop.signal });
    const left = async () => // two partial-index counts; `status <> 'done'` would scan the 300,000 done rows
      (await pool.query(`SELECT (SELECT count(*) FROM webhook_inbox WHERE status = 'pending')
        + (SELECT count(*) FROM webhook_inbox WHERE status = 'processing') AS n`)).rows[0].n;
    while ((await left()) > 0) await sleep(2);
    row[`${label}: drain 200, ms`] = Math.round(performance.now() - t0);
    stop.abort();
    await running;
  }
  drainRows.push(row);
}
table(drainRows);

const sweep: Array<Record<string, unknown>> = [];
for (const concurrency of [1, 2, 4, 8, 16, 32]) {
  await addPending(200, `c${concurrency}_`);
  const ms = await drainAll(1, { batchSize: 50, concurrency });
  sweep.push({ concurrency, 'drain 200 events, ms': ms, 'events/s': Math.round((200 / ms) * 1000) });
}
table(sweep);
save('webhook-claim', { doneRows: 300_000, claims: claimRows, drain: drainRows, concurrency: sweep });
await pool.end();
