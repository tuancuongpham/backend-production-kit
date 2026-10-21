// Exact semantic-cache search reads every live row of the scope, so where the embedding is stored matters.
//   A. vector(1536), default storage: pgvector's type is STORAGE EXTERNAL, so each 6 KB vector lives
//      out of line in the TOAST table and every row read costs extra TOAST index lookups
//   B. vector(1536), STORAGE MAIN: kept inside the heap row (it fits in an 8 KB page)
//   C. halfvec(1536), STORAGE MAIN: 2 bytes per dimension (pgvector >= 0.7), half the bytes to read
// Same rows in each table; the query is pgCache's default exact search.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/vector-storage.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/helpers.ts';
import { vectorParam } from '../../skills/llm-gateway/references/pg-stores.ts';
import { latency, randomVector, save, table } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_vecstorage'), max: 2 });
await runSqlFile(pool, 'llm-gateway', 'semantic-cache.sql');
const scopes = { 'scope-120': 120, 'scope-1000': 1000, 'scope-5000': 5000 } as const;
console.log('loading data…');
for (const [scope, n] of [...Object.entries(scopes), ['other', 10_000] as const]) {
  await pool.query(
    `INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at)
     SELECT CASE WHEN $1 = 'other' THEN 'other-' || (g % 100) ELSE $1 END, v.vec, '{"content":"cached answer"}', now() + interval '1 day'
     FROM generate_series(1, $2::int) g
     CROSS JOIN LATERAL (SELECT array_agg(random() - 0.5)::vector AS vec FROM generate_series(1, 1536) WHERE g > 0) v`,
    [scope, n],
  );
}
await pool.query(`
  CREATE TABLE cache_main (LIKE llm_semantic_cache INCLUDING ALL);
  ALTER TABLE cache_main ALTER COLUMN embedding SET STORAGE MAIN;
  INSERT INTO cache_main SELECT * FROM llm_semantic_cache;
  CREATE TABLE cache_half (id bigint PRIMARY KEY, scope text NOT NULL, embedding halfvec(1536) NOT NULL,
    value jsonb NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL);
  ALTER TABLE cache_half ALTER COLUMN embedding SET STORAGE MAIN;
  INSERT INTO cache_half SELECT id, scope, embedding::halfvec(1536), value, created_at, expires_at FROM llm_semantic_cache;
  CREATE INDEX ON cache_half (scope, expires_at);`);
for (const t of ['llm_semantic_cache', 'cache_main', 'cache_half']) await pool.query(`VACUUM ANALYZE ${t}`);

const variants = [
  { name: 'A. vector, default (TOAST)', table: 'llm_semantic_cache', probe: '$2::vector' },
  { name: 'B. vector, STORAGE MAIN', table: 'cache_main', probe: '$2::vector' },
  { name: 'C. halfvec, STORAGE MAIN', table: 'cache_half', probe: '$2::vector::halfvec' },
];
const exact = (t: string, probe: string) => `SELECT id, 1 - (embedding <=> ${probe}) AS similarity FROM ${t}
  WHERE scope = $1 AND expires_at > now() ORDER BY similarity DESC LIMIT 1`;
const probes = Array.from({ length: 50 }, (_, i) => vectorParam(randomVector(60_000 + i)));

const rows: Array<Record<string, unknown>> = [];
const reference = new Map<string, unknown[]>();
for (const v of variants) {
  const row: Record<string, unknown> = { storage: v.name };
  for (const scope of Object.keys(scopes)) {
    const sql = exact(v.table, v.probe);
    const top = [];
    for (const p of probes.slice(0, 20)) top.push((await pool.query(sql, [scope, p])).rows[0].id);
    if (!reference.has(scope)) reference.set(scope, top);
    const same = top.filter((id, i) => id === reference.get(scope)![i]).length;
    const lat = await latency(scope === 'scope-5000' ? 100 : 300, (i) => pool.query(sql, [scope, probes[i % probes.length]]), 20);
    row[`${scope} p50 ms`] = lat.p50;
    if (scope === 'scope-5000') row['same top-1 as A'] = `${same}/20`;
  }
  const size = (await pool.query(`SELECT pg_total_relation_size($1::regclass) AS b`, [v.table])).rows[0].b;
  row['table + TOAST + indexes'] = `${Math.round(Number(size) / 1024 / 1024)} MB`;
  let nextId = 10_000_000;
  const insert = await latency(200, (i) =>
    pool.query(`INSERT INTO ${v.table} (id, scope, embedding, value, created_at, expires_at)
      VALUES (${nextId++}, 'w', ${v.probe.replace('$2', '$1')}, '{}', now(), now())`, [vectorParam(randomVector(70_000 + i))]),
  );
  row['insert p50 ms'] = insert.p50;
  rows.push(row);
  await pool.query(`DELETE FROM ${v.table} WHERE scope = 'w'`);
}
table(rows);
save('vector-storage', { dims: 1536, scopes, background: 10_000, rows });
await pool.end();
