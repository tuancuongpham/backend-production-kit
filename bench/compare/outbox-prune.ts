// Outbox retention, the daily run: the table holds eight days of traffic and one of them is past the 7-day window.
// Data: 440,000 messages published in the last 7 days, 60,000 published 8 days ago, 1,000 still waiting, stored in
// random physical order. That is the steady state: after the first prunes, VACUUM frees space all over the table
// and new messages fill it, so the oldest rows are no longer at the start of the heap.
//   A. one DELETE … WHERE published_at < … (shipped pruneOutbox)
//   B. batches of 5,000 (DELETE … WHERE id IN (SELECT … LIMIT)), the way the other skills prune
//   C. the same batches through an index on published_at
// Reported: total time, and the longest single statement (how long one transaction holds its row locks and grows its
// WAL). Then the price of that index on the relay's hot path: 5,000 messages relayed, with and without it.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/outbox-prune.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { createRelay, pruneOutbox } from '../../skills/outbox-pattern/references/outbox.ts';
import { save, table } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_outbox_prune'), max: 4 });
await runSqlFile(pool, 'outbox-pattern', 'outbox.sql');
await pool.query(`DROP TRIGGER IF EXISTS outbox_notify_trg ON outbox`); // no listener here: don't time the NOTIFYs
const INDEX = `CREATE INDEX IF NOT EXISTS outbox_published_idx ON outbox (published_at) WHERE published_at IS NOT NULL`;
const NO_INDEX = `DROP INDEX IF EXISTS outbox_published_idx`;
const BATCH = `DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE published_at < now() - make_interval(days => $1) LIMIT $2)`;

async function fill(index: string) {
  await pool.query(`TRUNCATE outbox`);
  await pool.query(index);
  await pool.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, published_at)
     SELECT 'order', 'o' || g, 'order.placed', jsonb_build_object('n', g),
            CASE WHEN g <= 60000 THEN now() - interval '8 days' - make_interval(secs => g)
                 WHEN g <= 500000 THEN now() - make_interval(secs => (g % 600000)) END
     FROM generate_series(1, 501000) g ORDER BY random()`,
  );
  await pool.query(`VACUUM ANALYZE outbox`);
}

/** Runs the statements of one variant with their timings: the longest is the longest lock hold and WAL burst. */
async function timed(prune: (q: (sql: string, params: unknown[]) => Promise<number>) => Promise<number>) {
  const durations: number[] = [];
  const q = async (sql: string, params: unknown[]) => {
    const t0 = performance.now();
    const res = await pool.query(sql, params);
    durations.push(performance.now() - t0);
    return res.rowCount ?? 0;
  };
  const t0 = performance.now();
  const deleted = await prune(q);
  return { deleted, statements: durations.length, 'ms total': Math.round(performance.now() - t0), 'longest statement ms': Math.round(Math.max(...durations)) };
}
const batches = async (q: (sql: string, params: unknown[]) => Promise<number>) => {
  let total = 0;
  for (let n = -1; n !== 0; total += n) n = await q(BATCH, [7, 5000]);
  return total;
};

await fill(NO_INDEX);
const shipped = await pruneOutbox(pool);
const rows: Array<Record<string, unknown>> = [];
await fill(NO_INDEX);
rows.push({ variant: 'A. one DELETE (shipped)', ...(await timed((q) => q(`DELETE FROM outbox WHERE published_at < now() - make_interval(days => $1)`, [7]))) });
await fill(NO_INDEX);
rows.push({ variant: 'B. batches of 5,000', ...(await timed(batches)) });
await fill(INDEX);
rows.push({ variant: 'C. batches of 5,000 through an index on published_at', ...(await timed(batches)) });
table(rows);
console.log(`shipped pruneOutbox() deleted ${shipped} rows\n`);

// The index on the relay's hot path: every publish would also write an entry in it.
const relayRows: Array<Record<string, unknown>> = [];
const MESSAGES = 5000;
const relay = createRelay({ pool, publish: async () => {}, batchSize: 100 });
for (let round = 0; round < 3; round++) {
  for (const index of [NO_INDEX, INDEX]) {
    await pool.query(`TRUNCATE outbox`);
    await pool.query(index);
    await pool.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) SELECT 'order', 'o' || g, 'order.placed', jsonb_build_object('n', g) FROM generate_series(1, ${MESSAGES}) g`,
    );
    await pool.query(`VACUUM ANALYZE outbox`);
    const t0 = performance.now();
    let n = 0;
    for (let k; (k = await relay.relayOnce()) > 0; ) n += k;
    relayRows.push({ round, relay: index === INDEX ? 'with an index on published_at' : 'shipped (no such index)', 'messages/s': Math.round((n / (performance.now() - t0)) * 1000) });
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const relaySummary = ['shipped (no such index)', 'with an index on published_at'].map((relay) => ({
  relay,
  'messages/s, median of 3': median(relayRows.filter((r) => r.relay === relay).map((r) => r['messages/s'] as number)),
}));
table(relaySummary);
save('outbox-prune', { rows, shippedDeleted: shipped, relay: relayRows, relaySummary });
await pool.end();
