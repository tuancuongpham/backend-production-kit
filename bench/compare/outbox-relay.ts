// Outbox relay: marking messages as published.
//   A. one UPDATE per message (v0.2.0)
//   B. one UPDATE … WHERE id = ANY($1) per batch
//   C. the shipped createRelay() (B plus the per-message publish timeout), to check nothing else costs
// All commit the marks in the same transaction, so crash behaviour is identical: a crash before COMMIT
// re-publishes the whole batch either way (consumers dedup by message id).
// Run inside the Docker network:  npm run bench:docker -- bench/compare/outbox-relay.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { createRelay } from '../../skills/outbox-pattern/references/outbox.ts';
import { save, table } from './lib.ts';

const MESSAGES = 5000;
const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_outbox'), max: 4 });
await runSqlFile(pool, 'outbox-pattern', 'outbox.sql');
await pool.query(
  `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
   SELECT 'order', 'o' || g, 'order.placed', jsonb_build_object('n', g) FROM generate_series(1, ${MESSAGES}) g`,
);
const LOCK = 0x6f7574626f78;
const publish = async () => {}; // in-memory broker: isolates the relay's own database cost

async function relayOnce(markInBatch: boolean, batchSize: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await client.query(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [LOCK])).rows[0].ok) {
      await client.query('COMMIT');
      return 0;
    }
    const { rows } = await client.query(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, headers
       FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT $1`,
      [batchSize],
    );
    const done: string[] = [];
    for (const m of rows) {
      await publish();
      if (markInBatch) done.push(m.id);
      else await client.query(`UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = $1`, [m.id]);
    }
    if (done.length) await client.query(`UPDATE outbox SET published_at = now(), last_error = NULL WHERE id = ANY($1::uuid[])`, [done]);
    await client.query('COMMIT');
    return rows.length;
  } finally {
    client.release();
  }
}

const shipped = createRelay({ pool, publish, batchSize: 100 });
const rows: Array<Record<string, unknown>> = [];
for (const [name, once] of [
  ['A. one UPDATE per message (v0.2.0)', () => relayOnce(false, 100)],
  ['B. one UPDATE per batch', () => relayOnce(true, 100)],
  ['B. one UPDATE per batch, batch 500', () => relayOnce(true, 500)],
  ['C. shipped createRelay(), batch 100', () => shipped.relayOnce()],
] as const) {
  await pool.query(`UPDATE outbox SET published_at = NULL`);
  await pool.query(`VACUUM ANALYZE outbox`);
  const t0 = performance.now();
  let n = 0;
  for (let k; (k = await once()) > 0; ) n += k;
  const ms = performance.now() - t0;
  rows.push({ variant: name, published: n, 'ms total': Math.round(ms), 'messages/s': Math.round((n / ms) * 1000) });
}
table(rows);
save('outbox-relay', { messages: MESSAGES, rows });
await pool.end();
