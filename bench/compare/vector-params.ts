// How to send an embedding to Postgres: as text (what `[${v.join(',')}]` produces) or binary?
//   A. text, JS default number formatting (17 significant digits)
//   B. text, 9 significant digits (float32 round-trips exactly; pgvector stores float32 anyway)
//   C. binary: node-postgres sends Buffer parameters in binary format, pgvector reads them with
//      vector_recv: int16 dim, int16 unused, then dim × float32 big-endian
// Run inside the Docker network:  npm run bench:docker -- bench/compare/vector-params.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/helpers.ts';
import { vectorParam } from '../../skills/llm-gateway/references/pg-stores.ts';
import { latency, randomVector, save, table } from './lib.ts';

const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n); // embedding APIs return unit vectors: values around ±0.03
};
// synchronous_commit off: every insert would otherwise wait for a WAL flush, and fsync time on Docker
// Desktop's virtual disk swings more between runs than the encodings differ. The flush is the same for all
// three encodings, so leaving it out isolates what is being compared.
const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_vecparams'), max: 2, options: '-c synchronous_commit=off' });
await runSqlFile(pool, 'llm-gateway', 'semantic-cache.sql');
await pool.query(`
  INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at)
  SELECT CASE WHEN g <= 120 THEN 'tenant-7' ELSE 'tenant-' || (g % 50) END, v.vec, '{}', now() + interval '1 day'
  FROM generate_series(1, 5000) g
  CROSS JOIN LATERAL (SELECT array_agg(random() - 0.5)::vector AS vec FROM generate_series(1, 1536) WHERE g > 0) v`);
await pool.query(`ANALYZE llm_semantic_cache`);

const encoders: Record<string, (v: number[]) => string | Buffer> = {
  'A. text, 17 digits (v0.2.0)': (v) => `[${v.join(',')}]`,
  'B. text, 9 digits': (v) => `[${v.map((x) => +x.toPrecision(9)).join(',')}]`,
  'C. binary (vector_recv)': vectorParam,
};
const LOOKUP = `SELECT 1 - (embedding <=> $2::vector) AS similarity FROM llm_semantic_cache
  WHERE scope = $1 AND expires_at > now() ORDER BY similarity DESC LIMIT 1`;
const probes = Array.from({ length: 50 }, (_, i) => unit(randomVector(40_000 + i)));

const rows: Array<Record<string, unknown>> = [];
const reference: number[] = [];
for (const [name, enc] of Object.entries(encoders)) {
  const sims: number[] = [];
  for (const p of probes) sims.push((await pool.query(LOOKUP, ['tenant-7', enc(p)])).rows[0].similarity);
  if (!reference.length) reference.push(...sims);
  const maxDiff = Math.max(...sims.map((s, i) => Math.abs(s - reference[i])));
  const lookup = await latency(300, (i) => pool.query(LOOKUP, ['tenant-7', enc(probes[i % probes.length])]));
  const insert = await latency(300, (i) =>
    pool.query(`INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at) VALUES ('w', $1::vector, '{}', now())`, [enc(probes[i % probes.length])]),
  );
  rows.push({
    encoding: name,
    'bytes per vector': Buffer.byteLength(enc(probes[0]) as string),
    'lookup p50 ms': lookup.p50,
    'insert p50 ms': insert.p50,
    'max similarity diff vs A': maxDiff.toExponential(1),
  });
}
table(rows);
save('vector-params', { dims: 1536, rows });
await pool.end();
