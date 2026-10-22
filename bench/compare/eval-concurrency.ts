// How long the retrieval eval takes in CI, one query at a time or several. The retriever is the shipped hybrid
// search on the Vietnamese help center (verify/tests/fixtures/help-center.ts), behind an embedding call: a real
// retriever embeds each query through an API first, simulated here as 80 ms, the latency of a hosted embedding model.
// The golden set is the fixture's 22 queries repeated to 198, the size of a team's set after a few months.
//   evaluateRetriever(golden, retrieve, 5, { concurrency })   with concurrency 1 (0.5.0's behaviour), 4 (default), 8
// Run inside the Docker network:  npm run bench:docker -- bench/compare/eval-concurrency.ts
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { fakeEmbedding, toVectorLiteral } from '../../verify/tests/support/vectors.ts';
import { CHUNKS, KEYWORD_QUERIES, QUESTION_QUERIES, TENANT } from '../../verify/tests/fixtures/help-center.ts';
import { hybridSearch, withTenant } from '../../skills/multitenant-postgres/references/tenant-db.ts';
import { evaluateRetriever, type GoldenQuery } from '../../skills/rag-evals/references/retrieval-eval.ts';
import { save, table } from './lib.ts';

const EMBEDDING_MS = 80;
const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_eval_concurrency'), max: 10 });
await runSqlFile(pool, 'multitenant-postgres', 'schema.sql');
await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Shop')`, [TENANT]);
const doc = (await pool.query(`INSERT INTO documents (tenant_id, title) VALUES ($1, 'Help center') RETURNING id`, [TENANT])).rows[0].id;
const nameOf = new Map<string, string>();
let seed = 1;
for (const [name, content] of Object.entries(CHUNKS)) {
  const { rows } = await pool.query(`INSERT INTO chunks (tenant_id, document_id, content, embedding) VALUES ($1, $2, $3, $4) RETURNING id`, [
    TENANT,
    doc,
    content,
    toVectorLiteral(fakeEmbedding(seed++)),
  ]);
  nameOf.set(rows[0].id, name);
}
const base = [...KEYWORD_QUERIES, ...QUESTION_QUERIES];
const golden: GoldenQuery[] = Array.from({ length: 9 }, (_, round) => base.map((q) => ({ ...q, id: `${q.id}-${round}` }))).flat();
const retrieve = async (q: GoldenQuery) => {
  await sleep(EMBEDDING_MS); // the embedding API
  const hits = await withTenant(pool, TENANT, (c) => hybridSearch(c, { embedding: fakeEmbedding(golden.indexOf(q) + 1000), query: q.query, limit: 5 }));
  return hits.map((h) => nameOf.get(h.id)!);
};

const rows: Array<Record<string, unknown>> = [];
let reference: string | undefined;
for (const concurrency of [1, 4, 8]) {
  const t0 = performance.now();
  const report = await evaluateRetriever(golden, retrieve, 5, { concurrency });
  const ms = performance.now() - t0;
  const summary = JSON.stringify([report.recall, report.mrr, report.ndcg]);
  reference ??= summary;
  rows.push({
    concurrency: concurrency === 1 ? '1 (0.5.0)' : concurrency === 4 ? '4 (default)' : String(concurrency),
    queries: report.queries,
    seconds: Math.round(ms / 100) / 10,
    'same metrics': summary === reference ? 'yes' : `no: ${summary}`,
  });
}
table(rows);
save('eval-concurrency', { embeddingMs: EMBEDDING_MS, rows });
await pool.end();
