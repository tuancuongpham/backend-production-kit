// LLM budget reservation (hot path: runs before every paid model call).
//   A. two statements (v0.2.0): INSERT … ON CONFLICT DO NOTHING, then a conditional UPDATE
//   B. one statement: INSERT … SELECT … WHERE fits ON CONFLICT DO UPDATE … WHERE fits RETURNING
//   C. the shipped pgBudget().reserve, to check it is B
// All must stay exact under concurrency: 200 parallel $1 reservations against a $50 limit → 50 succeed.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/budget.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/helpers.ts';
import { pgBudget } from '../../skills/llm-gateway/references/pg-stores.ts';
import { latency, save, table, throughput } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_budget'), max: 16 });
await runSqlFile(pool, 'llm-gateway', 'semantic-cache.sql');
const shipped = pgBudget(pool);

type Reserve = (tenant: string, period: string, usd: number, limit: number) => Promise<boolean>;
const variants: Record<string, Reserve> = {
  'A. two statements (v0.2.0)': async (t, p, usd, limit) => {
    await pool.query(`INSERT INTO llm_budget (tenant_id, period) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [t, p]);
    const r = await pool.query(
      `UPDATE llm_budget SET reserved_usd = reserved_usd + $3
       WHERE tenant_id = $1 AND period = $2 AND spent_usd + reserved_usd + $3 <= $4`,
      [t, p, usd, limit],
    );
    return r.rowCount === 1;
  },
  'B. one upsert': async (t, p, usd, limit) => {
    const r = await pool.query(
      `INSERT INTO llm_budget AS b (tenant_id, period, reserved_usd)
       SELECT $1, $2, $3::numeric WHERE $3::numeric <= $4::numeric
       ON CONFLICT (tenant_id, period) DO UPDATE SET reserved_usd = b.reserved_usd + EXCLUDED.reserved_usd
       WHERE b.spent_usd + b.reserved_usd + EXCLUDED.reserved_usd <= $4::numeric
       RETURNING 1`,
      [t, p, usd, limit],
    );
    return r.rowCount === 1;
  },
  'C. shipped pgBudget()': (t, p, usd, limit) => shipped.reserve(t, p, usd, limit),
};

const rows: Array<Record<string, unknown>> = [];
for (const [name, reserve] of Object.entries(variants)) {
  await pool.query(`TRUNCATE llm_budget`);
  const seq = await latency(2000, (i) => reserve(`tenant-${i % 50}`, '2026-10', 0.001, 1e9));
  // Contended throughput swings ±15% between runs: report the median of three.
  const runs: number[] = [];
  for (let r = 0; r < 3; r++) runs.push(await throughput(8000, 16, (i) => reserve(`tenant-${i % 50}`, '2026-10', 0.001, 1e9)));
  const conc = runs.sort((a, b) => a - b)[1];
  await pool.query(`TRUNCATE llm_budget`);
  let granted = 0;
  await throughput(200, 16, async () => {
    if (await reserve('contended', '2026-10', 1, 50)) granted++;
  });
  const firstTooBig = await reserve('fresh-tenant', '2026-10', 5, 1); // estimate alone exceeds the limit
  rows.push({
    variant: name,
    'p50 ms': seq.p50,
    'p95 ms': seq.p95,
    'reservations/s (16 parallel)': conc,
    'granted of 200 ($50 limit)': granted,
    'oversized first call refused': !firstTooBig,
  });
}
table(rows);
save('budget', { rows });
await pool.end();
