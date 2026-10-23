// The webhook worker's transaction for one claimed event, without the claim. The handler writes one row (a credit),
// as a payment handler does. Round trips are the cost:
//   A. BEGIN / lock own row / handler / mark done / COMMIT                    (5 round trips with this handler, 0.6.0)
//   B. "BEGIN; lock own row" as one call / handler / "mark done; COMMIT"     (3 round trips)
//   C. the shipped worker, draining claimed events one batch of 10 at a time  (B, plus one claim per batch)
// A and B alternate event by event (so a busy machine slows both alike), five rounds of 2,000 events each after a
// warm-up; the table shows the median round. C drains 2,000 events per round.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/webhook-process.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { withClient, withTransaction } from '../../skills/webhook-ingestion/references/pg-transaction.ts';
import { createInboxWorker, type InboxRow } from '../../skills/webhook-ingestion/references/webhooks.ts';
import { save, stats, table, type Stats } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_webhook_process'), max: 8 });
await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
await pool.query(`CREATE TABLE credits (event_id text PRIMARY KEY, amount int NOT NULL)`);

/** `n` events, claimed (status 'processing', a lease each), as the worker's claim leaves them. */
async function claimed(n: number, prefix: string): Promise<Array<{ id: string; lease_id: string; event_id: string }>> {
  const { rows } = await pool.query(
    `INSERT INTO webhook_inbox (provider, event_id, event_type, payload, status, attempts, locked_at, lease_id)
     SELECT 'stripe', $2 || g, 'payment.succeeded', '{"amount": 125000}', 'processing', 1, now(), gen_random_uuid()
     FROM generate_series(1, $1::int) g
     RETURNING id, lease_id, event_id`,
    [n, prefix],
  );
  return rows;
}

const credit = (tx: pg.PoolClient, eventId: string) => tx.query(`INSERT INTO credits (event_id, amount) VALUES ($1, 125000)`, [eventId]);
const DONE = `UPDATE webhook_inbox SET status = 'done', processed_at = now(), locked_at = NULL, lease_id = NULL, last_error = NULL WHERE id = `;

const variants: Record<string, (row: { id: string; lease_id: string; event_id: string }) => Promise<unknown>> = {
  'A. lock, mark done, BEGIN and COMMIT as calls of their own (0.6.0)': (row) =>
    withTransaction(pool, async (tx) => {
      const own = await tx.query(`SELECT 1 FROM webhook_inbox WHERE id = $1 AND lease_id = $2 FOR UPDATE`, [row.id, row.lease_id]);
      if (own.rowCount === 0) return 'lost';
      await credit(tx, row.event_id);
      await tx.query(`${DONE}$1`, [row.id]);
      return 'done';
    }),
  'B. "BEGIN; lock" and "mark done; COMMIT" as one call each': (row) =>
    withClient(pool, async (tx) => {
      const results = (await tx.query(
        `BEGIN; SELECT 1 FROM webhook_inbox WHERE id = ${Number(row.id)} AND lease_id = '${row.lease_id}' FOR UPDATE`,
      )) as unknown as pg.QueryResult[];
      if (results[1].rowCount === 0) {
        await tx.query('ROLLBACK');
        return 'lost';
      }
      await credit(tx, row.event_id);
      await tx.query(`${DONE}${Number(row.id)}; COMMIT`);
      return 'done';
    }),
};

const names = Object.keys(variants);
const rounds: Record<string, Stats[]> = Object.fromEntries(names.map((v) => [v, []]));
for (let round = -1; round < 5; round++) {
  const n = round < 0 ? 200 : 2000; // round -1 warms both up
  const rows = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await claimed(n, `${name.slice(0, 1)}${round}_`)] as const)));
  const samples: Record<string, number[]> = Object.fromEntries(names.map((v) => [v, []]));
  for (let i = 0; i < n; i++) {
    for (const name of names) {
      const t0 = performance.now();
      await variants[name](rows[name][i]);
      samples[name].push(performance.now() - t0);
    }
  }
  if (round >= 0) for (const name of names) rounds[name].push(stats(samples[name]));
}

// C. The shipped worker draining 2,000 claimed-then-released events (status 'pending', due now).
const drains: number[] = [];
let drained = 0;
const worker = createInboxWorker({
  pool,
  batchSize: 10,
  handlers: { 'stripe:payment.succeeded': async (row: InboxRow, tx) => void (await credit(tx, row.event_id), drained++) },
});
for (let round = 0; round < 5; round++) {
  await pool.query(
    `INSERT INTO webhook_inbox (provider, event_id, event_type, payload, next_attempt_at)
     SELECT 'stripe', 'C' || $1::int || '_' || g, 'payment.succeeded', '{"amount": 125000}', now() - interval '1 minute' FROM generate_series(1, 2000) g`,
    [round],
  );
  drained = 0;
  const t0 = performance.now();
  while ((await worker.processOnce()).length > 0);
  drains.push((performance.now() - t0) / drained);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = [
  ...Object.entries(rounds).map(([variant, s]) => ({
    variant,
    'p50 ms': median(s.map((x) => x.p50)),
    'p95 ms': median(s.map((x) => x.p95)),
    'mean ms': median(s.map((x) => x.mean)),
  })),
  { variant: 'C. shipped worker, per event (batches of 10)', 'p50 ms': '-', 'p95 ms': '-', 'mean ms': Math.round(median(drains) * 1000) / 1000 },
];
table(rows);
save('webhook-process', { rows, rounds, drains });
await pool.end();
