// The agent's tool call, end to end. The executor opens a read-only transaction, sets the tenant and a statement
// timeout, runs the developer's query and commits. For a primary-key lookup, the round trips are the cost:
//   A. BEGIN READ ONLY / set_config(tenant, timeout) / query / COMMIT          (4 round trips, 0.5.0)
//   B. "BEGIN READ ONLY; SELECT set_config(…)" as one call / query / COMMIT     (3 round trips)
//   C. shipped createAgentDb().run() (= B, with the parameter checks and the audit)
// Variants run interleaved, three rounds of 2,000 calls each; the table shows the median round.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/agent-db.ts
import pg from 'pg';
import { freshDatabase } from '../../verify/tests/support/infra.ts';
import { createAgentDb } from '../../skills/agent-safe-db/references/agent-db-tool.ts';
import { withTransaction } from '../../skills/agent-safe-db/references/pg-transaction.ts';
import { latency, save, table, type Stats } from './lib.ts';

const dbUrl = await freshDatabase('kit_bench_agent_db');
const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
await pool.query(`
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, status text, total_amount numeric);
  INSERT INTO orders (tenant_id, status, total_amount)
    SELECT ('00000000-0000-4000-8000-' || lpad((g % 50)::text, 12, '0'))::uuid, 'paid', g FROM generate_series(1, 50000) g;
  ANALYZE orders`);
const picks: Array<{ id: string; tenant_id: string }> = (await pool.query(`SELECT id, tenant_id FROM orders ORDER BY random() LIMIT 200`)).rows;
const SQL = 'SELECT id, status, total_amount FROM orders WHERE id = $1';
const TIMEOUT_MS = 2000;

const variants: Record<string, (i: number) => Promise<unknown>> = {};
variants['A. set_config as its own query (0.5.0)'] = (i) => {
  const { id, tenant_id } = picks[i % picks.length];
  return withTransaction(
    pool,
    async (tx) => {
      await tx.query(`SELECT set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)`, [tenant_id, String(TIMEOUT_MS)]);
      return tx.query(`SELECT * FROM (${SQL}) AS q LIMIT 201`, [id]);
    },
    { begin: 'BEGIN READ ONLY' },
  );
};
variants['B. BEGIN and set_config in one call'] = (i) => {
  const { id, tenant_id } = picks[i % picks.length];
  return withTransaction(pool, (tx) => tx.query(`SELECT * FROM (${SQL}) AS q LIMIT 201`, [id]), {
    begin: `BEGIN READ ONLY; SELECT set_config('app.tenant_id', '${tenant_id}', true), set_config('statement_timeout', '${TIMEOUT_MS}', true)`,
  });
};
const agent = createAgentDb({
  connectionString: dbUrl,
  tools: { get_order: { description: 'One order', sql: SQL, params: [{ name: 'id', type: 'uuid', description: 'Order id' }] } },
  audit: () => {},
  statementTimeoutMs: TIMEOUT_MS,
  poolSize: 4,
});
variants['C. shipped createAgentDb().run()'] = (i) => {
  const { id, tenant_id } = picks[i % picks.length];
  return agent.run('get_order', { id }, { tenantId: tenant_id, userId: 'bench' });
};

const rounds: Record<string, Stats[]> = Object.fromEntries(Object.keys(variants).map((v) => [v, []]));
for (let round = 0; round < 3; round++) {
  for (const [name, fn] of Object.entries(variants)) rounds[name].push(await latency(2000, fn, 200));
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = Object.entries(rounds).map(([variant, s]) => ({
  variant,
  'p50 ms': median(s.map((x) => x.p50)),
  'p95 ms': median(s.map((x) => x.p95)),
  'mean ms': median(s.map((x) => x.mean)),
}));
table(rows);
save('agent-db', { rows, rounds });
await agent.close();
await pool.end();
