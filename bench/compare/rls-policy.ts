// Row-Level Security cost, measured two ways.
//   policy:  how the policy reads the tenant id. Only the query is timed, inside the tenant transaction.
//     1. tenant_id = current_tenant_id()            (shipped: SQL function, STABLE → inlined)
//     2. tenant_id = (SELECT current_tenant_id())   (the "wrap it in a sub-select" advice)
//     3. tenant_id = NULLIF(current_setting(…), '')::uuid   (expression written out)
//     4. tenant_id = current_tenant_id_volatile()   (plpgsql function, VOLATILE by default — the pitfall)
//     baseline: no RLS (superuser), explicit WHERE tenant_id = $1
//   request: one withTenant() call end to end for a primary-key lookup, where round trips dominate
//     A. BEGIN / set_config / query / COMMIT                      (4 round trips)
//     B. "BEGIN; SELECT set_config(…)" as one call / query / COMMIT (3 round trips)
//     floor: one query with an explicit WHERE, no transaction, no RLS (1 round trip)
// Data: 200 tenants × 1,000 documents = 200,000 rows.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/rls-policy.ts
import pg from 'pg';
import { freshDatabase, runSqlFile, withUser } from '../../verify/tests/helpers.ts';
import { latency, planSummary, save, selfTimed, table } from './lib.ts';

const dbUrl = await freshDatabase('kit_bench_rls');
const admin = new pg.Client({ connectionString: dbUrl });
await admin.connect();
await runSqlFile(admin, 'multitenant-postgres', 'schema.sql');
await admin.query(`ALTER ROLE app_user PASSWORD 'bench-pw'`);
await admin.query(`INSERT INTO tenants (id, name) SELECT gen_random_uuid(), 't' || g FROM generate_series(1, 200) g`);
await admin.query(`INSERT INTO documents (tenant_id, title) SELECT t.id, 'doc ' || g FROM tenants t, generate_series(1, 1000) g`);
await admin.query(`VACUUM ANALYZE documents`);
await admin.query(`CREATE OR REPLACE FUNCTION current_tenant_id_volatile() RETURNS uuid LANGUAGE plpgsql
  AS $$ BEGIN RETURN NULLIF(current_setting('app.tenant_id', true), '')::uuid; END $$`);
const picks: Array<{ tenant: string; doc: string }> = (
  await admin.query(`SELECT DISTINCT ON (tenant_id) tenant_id AS tenant, id AS doc FROM documents ORDER BY tenant_id, id LIMIT 20`)
).rows;

const app = new pg.Client({ connectionString: withUser(dbUrl, 'app_user', 'bench-pw') });
await app.connect();
const COUNT = 'SELECT count(*)::int AS n FROM documents';
const PAGE = 'SELECT id, title FROM documents ORDER BY title DESC LIMIT 20';

/** Opens the tenant transaction, times only `sql`, commits. */
const queryInTenantTx = async (sql: string, tenant: string) => {
  await app.query('BEGIN');
  await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
  const t0 = performance.now();
  const r = await app.query(sql);
  const ms = performance.now() - t0;
  await app.query('COMMIT');
  if (sql === COUNT && r.rows[0].n !== 1000) throw new Error(`expected 1000 rows, got ${r.rows[0].n}`);
  return ms;
};
const queryWithWhere = async (sql: string, tenant: string) => {
  const t0 = performance.now();
  await admin.query(sql.replace('FROM documents', 'FROM documents WHERE tenant_id = $1'), [tenant]);
  return performance.now() - t0;
};

const variants: Record<string, string> = {
  '1. current_tenant_id() (shipped)': `tenant_id = current_tenant_id()`,
  '2. (SELECT current_tenant_id())': `tenant_id = (SELECT current_tenant_id())`,
  '3. expression written out': `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
  '4. plpgsql VOLATILE function': `tenant_id = current_tenant_id_volatile()`,
};
const policyRows: Array<Record<string, unknown>> = [];
for (const [name, expr] of Object.entries(variants)) {
  await admin.query(`ALTER POLICY tenant_isolation ON documents USING (${expr}) WITH CHECK (${expr})`);
  const count = await selfTimed(300, (i) => queryInTenantTx(COUNT, picks[i % picks.length].tenant));
  const page = await selfTimed(300, (i) => queryInTenantTx(PAGE, picks[i % picks.length].tenant));
  await app.query('BEGIN');
  await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [picks[0].tenant]);
  const plan = planSummary((await app.query(`EXPLAIN (FORMAT JSON) ${COUNT}`)).rows[0]['QUERY PLAN']);
  await app.query('COMMIT');
  policyRows.push({ policy: name, 'count(*) p50 ms': count.p50, 'top-20 page p50 ms': page.p50, 'plan for count(*)': plan });
}
await admin.query(`ALTER POLICY tenant_isolation ON documents USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
{
  const count = await selfTimed(300, (i) => queryWithWhere(COUNT, picks[i % picks.length].tenant));
  const page = await selfTimed(300, (i) => queryWithWhere(PAGE, picks[i % picks.length].tenant));
  const plan = planSummary((await admin.query(`EXPLAIN (FORMAT JSON) SELECT count(*) FROM documents WHERE tenant_id = $1`, [picks[0].tenant])).rows[0]['QUERY PLAN']);
  policyRows.push({ policy: 'no RLS, explicit WHERE (baseline)', 'count(*) p50 ms': count.p50, 'top-20 page p50 ms': page.p50, 'plan for count(*)': plan });
}
table(policyRows);

// One request = one withTenant() around a primary-key lookup.
const LOOKUP = 'SELECT id, title FROM documents WHERE id = $1';
const shapes: Record<string, (p: { tenant: string; doc: string }) => Promise<unknown>> = {
  'A. BEGIN / set_config / query / COMMIT': async ({ tenant, doc }) => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
    const r = await app.query(LOOKUP, [doc]);
    await app.query('COMMIT');
    if (r.rowCount !== 1) throw new Error('lookup missed');
  },
  'B. "BEGIN; set_config" in one call / query / COMMIT': async ({ tenant, doc }) => {
    await app.query(`BEGIN; SELECT set_config('app.tenant_id', '${tenant}', true)`); // tenant is a uuid read from the db
    const r = await app.query(LOOKUP, [doc]);
    await app.query('COMMIT');
    if (r.rowCount !== 1) throw new Error('lookup missed');
  },
  'floor: one query, explicit WHERE, no RLS': ({ tenant, doc }) =>
    admin.query(`SELECT id, title FROM documents WHERE id = $1 AND tenant_id = $2`, [doc, tenant]),
};
const requestRows: Array<Record<string, unknown>> = [];
for (const [name, run] of Object.entries(shapes)) {
  const lat = await latency(1000, (i) => run(picks[i % picks.length]));
  requestRows.push({ 'request shape': name, 'p50 ms': lat.p50, 'p95 ms': lat.p95 });
}
table(requestRows);
save('rls-policy', { rows: 200_000, tenants: 200, policies: policyRows, requests: requestRows });
await app.end();
await admin.end();
