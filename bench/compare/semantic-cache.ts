// Semantic cache lookup: which way of finding "the nearest cached answer of THIS tenant" is right and fast?
//   A. HNSW + WHERE scope   (v0.2.0)   — planner's choice; filter runs after the index's ef_search rows
//   B. HNSW + iterative scan           — pgCache(pool, { semanticSearch: 'ann' }), pgvector >= 0.8
//   C. exact within scope              — pgCache(pool) default: distance to every live row of the scope
// Data: 100 small tenants (100 rows each) + 1 big tenant (5,000 rows), plus 20 "popular questions" that
// every tenant has cached once (paraphrases, cosine ≈ 0.99 to each other). Probes ask a popular question
// as a tenant would; a hit = any own entry with similarity >= 0.95 returned. All three send the probe
// the same way (binary vectorParam), so latencies differ only by the query.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/semantic-cache.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { pgCache, vectorParam } from '../../skills/llm-gateway/references/pg-stores.ts';
import { latency, near, planSummary, randomVector, save, table, vectorLiteral } from './lib.ts';

const QUESTIONS = 20;
const THRESHOLD = 0.95;
const dbUrl = await freshDatabase('kit_bench_semcache');
const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
await runSqlFile(pool, 'llm-gateway', 'semantic-cache.sql');

console.log('loading data…');
const bg = (scopeExpr: string, n: number) =>
  pool.query(`
    INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at)
    SELECT ${scopeExpr}, v.vec, '{"content":"background"}', now() + interval '1 day'
    FROM generate_series(1, ${n}) g
    CROSS JOIN LATERAL (SELECT array_agg(random() - 0.5)::vector AS vec FROM generate_series(1, 1536) WHERE g > 0) v`);
await bg(`'tenant-' || (g % 100)`, 10_000);
await bg(`'tenant-big'`, 5_000);
const tenants = [...Array.from({ length: 100 }, (_, i) => `tenant-${i}`), 'tenant-big'];
const centers = Array.from({ length: QUESTIONS }, (_, q) => randomVector(10_000 + q));
for (let q = 0; q < QUESTIONS; q++) {
  const values = tenants.map((_, t) => `($${t * 3 + 1}, $${t * 3 + 2}::vector, $${t * 3 + 3}, now() + interval '1 day')`).join(',');
  const params = tenants.flatMap((scope, t) => [scope, vectorLiteral(near(centers[q], q * 1000 + t, 0.1)), JSON.stringify({ content: `q${q}:${scope}` })]);
  await pool.query(`INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at) VALUES ${values}`, params);
}
const total = (await pool.query(`SELECT count(*)::int AS n FROM llm_semantic_cache`)).rows[0].n;

console.log(`building HNSW over ${total} rows…`);
const builder = await pool.connect();
await builder.query(`SET maintenance_work_mem = '1GB'`);
// With vectors stored in the row the heap is big enough for Postgres to plan a parallel build, which puts
// the 1 GB graph in /dev/shm, and Docker's default 64 MB shm fails with "could not resize shared memory
// segment". Build serially here; in your own container raise --shm-size instead.
await builder.query(`SET max_parallel_maintenance_workers = 0`);
const t0 = performance.now();
await builder.query(`CREATE INDEX llm_semantic_cache_vec_idx ON llm_semantic_cache USING hnsw (embedding vector_cosine_ops)`);
const buildSec = Math.round((performance.now() - t0) / 100) / 10;
await builder.query(`ANALYZE llm_semantic_cache`);
builder.release();

const legacy = async (scope: string, v: number[]) =>
  (
    await pool.query(
      `SELECT value, 1 - (embedding <=> $2::vector) AS similarity FROM llm_semantic_cache
       WHERE scope = $1 AND expires_at > now() ORDER BY embedding <=> $2::vector LIMIT 1`,
      [scope, vectorParam(v)],
    )
  ).rows[0] as { value: { content: string }; similarity: number } | undefined;
const ann = pgCache(pool, { semanticSearch: 'ann' });
const exact = pgCache(pool);
const strategies: Record<string, (scope: string, v: number[]) => Promise<{ content?: string; similarity?: number } | null>> = {
  'A. HNSW + WHERE scope (v0.2.0)': async (s, v) => {
    const r = await legacy(s, v);
    return r && r.similarity >= THRESHOLD ? { content: r.value.content, similarity: r.similarity } : null;
  },
  'B. HNSW + iterative scan': async (s, v) => {
    const r = await ann.findSimilar(s, v, THRESHOLD);
    return r && { content: r.value.content, similarity: r.similarity };
  },
  'C. exact within scope (default)': async (s, v) => {
    const r = await exact.findSimilar(s, v, THRESHOLD);
    return r && { content: r.value.content, similarity: r.similarity };
  },
};

const rows: Array<Record<string, unknown>> = [];
for (const scope of ['tenant-big', 'tenant-7']) {
  const plan = planSummary(
    (
      await pool.query(
        `EXPLAIN (FORMAT JSON) SELECT value FROM llm_semantic_cache WHERE scope = $1 AND expires_at > now()
         ORDER BY embedding <=> $2::vector LIMIT 1`,
        [scope, vectorParam(near(centers[0], 1, 0.05))],
      )
    ).rows[0]['QUERY PLAN'],
  );
  for (const [name, find] of Object.entries(strategies)) {
    let hits = 0;
    for (let q = 0; q < QUESTIONS; q++) {
      const r = await find(scope, near(centers[q], 777_000 + q, 0.05));
      if (r?.content === `q${q}:${scope}`) hits++;
    }
    const lat = await latency(100, (i) => find(scope, near(centers[i % QUESTIONS], 888_000 + i, 0.05)), 20);
    rows.push({
      scope: scope === 'tenant-big' ? 'big tenant (5,020 rows)' : 'small tenant (120 rows)',
      strategy: name,
      'hit rate': `${hits}/${QUESTIONS}`,
      'p50 ms': lat.p50,
      'p95 ms': lat.p95,
      ...(name.startsWith('A') ? { 'plan for A': plan } : { 'plan for A': '' }),
    });
  }
}
table(rows);

// Write cost: what the HNSW index adds to every cache save.
const insert = (i: number) =>
  pool.query(
    `INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at) VALUES ('tenant-write', $1::vector, '{}', now() + interval '1 day')`,
    [vectorParam(randomVector(5_000_000 + i))],
  );
const withIndex = await latency(300, insert, 20);
await pool.query(`DROP INDEX llm_semantic_cache_vec_idx`);
const withoutIndex = await latency(300, (i) => insert(10_000 + i), 20);
const writes = [
  { 'cache save': 'with HNSW index', 'p50 ms': withIndex.p50, 'p95 ms': withIndex.p95 },
  { 'cache save': 'without HNSW index', 'p50 ms': withoutIndex.p50, 'p95 ms': withoutIndex.p95 },
];
table(writes);
console.log(`rows: ${total}, HNSW build: ${buildSec} s, ef_search: 40 (default)`);
save('semantic-cache', { rows: total, hnswBuildSeconds: buildSec, lookups: rows, writes });
await pool.end();
