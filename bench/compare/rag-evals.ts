// What the retrieval eval shows on a small Vietnamese help center (verify/tests/fixtures/help-center.ts):
//   1. the shipped hybrid search vs the same query with kit_unaccent dropped from the query side
//   2. the keyword retriever alone, on search-box queries vs the same needs asked as questions
// Query embeddings are noise here (no embedding model), so keyword search carries retrieval.
// Run inside the Docker network:  npm run bench:docker -- bench/compare/rag-evals.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { fakeEmbedding, toVectorLiteral } from '../../verify/tests/support/vectors.ts';
import { CHUNKS, KEYWORD_QUERIES, QUESTION_QUERIES, TENANT } from '../../verify/tests/fixtures/help-center.ts';
import { hybridSearch, withTenant } from '../../skills/multitenant-postgres/references/tenant-db.ts';
import { compareReports, evaluateRetriever, toMarkdown, type GoldenQuery } from '../../skills/rag-evals/references/retrieval-eval.ts';
import { save, table } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_rag'), max: 4 });
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
const probe = (q: GoldenQuery) => fakeEmbedding(1000 + q.id.length * 100 + Number(q.id.replace(/\D/g, '')));

const shipped = (q: GoldenQuery) =>
  withTenant(pool, TENANT, (c) => hybridSearch(c, { embedding: probe(q), query: q.query, limit: 5 })).then((hits) => hits.map((h) => nameOf.get(h.id)!));
// AND: websearch_to_tsquery, every word must match (what hybridSearch shipped with).
// OR: any word may match; ts_rank_cd ranks chunks matching more of them higher.
const AND_QUERY = `websearch_to_tsquery('simple', kit_unaccent($1))`;
const OR_QUERY = `to_tsquery('simple', array_to_string(ARRAY(
  SELECT quote_literal(w) FROM unnest(tsvector_to_array(to_tsvector('simple', kit_unaccent($1)))) w), ' | '))`;
const keywordOnly = (tsq: string) => (q: GoldenQuery) =>
  withTenant(pool, TENANT, async (c) => {
    const { rows } = await c.query(`SELECT id FROM chunks WHERE tsv @@ ${tsq} ORDER BY ts_rank_cd(tsv, ${tsq}) DESC LIMIT 5`, [q.query]);
    return rows.map((r) => nameOf.get(r.id)!);
  });
// FALLBACK: chunks matching every word; only when there are none, chunks matching any word.
const keywordFallback = (q: GoldenQuery) =>
  withTenant(pool, TENANT, async (c) => {
    const { rows } = await c.query(
      `WITH full_match AS (
         SELECT id, ts_rank_cd(tsv, ${AND_QUERY}) AS score FROM chunks WHERE tsv @@ ${AND_QUERY} ORDER BY score DESC LIMIT 5),
       partial AS (
         SELECT id, ts_rank_cd(tsv, ${OR_QUERY}) AS score FROM chunks
         WHERE tsv @@ ${OR_QUERY} AND NOT EXISTS (SELECT 1 FROM full_match) ORDER BY score DESC LIMIT 5)
       SELECT id FROM (SELECT * FROM full_match UNION ALL SELECT * FROM partial) k ORDER BY score DESC`,
      [q.query],
    );
    return rows.map((r) => nameOf.get(r.id)!);
  });
const hybridFallback = (q: GoldenQuery) =>
  withTenant(pool, TENANT, async (c) => {
    const { rows } = await c.query(
      `WITH semantic AS (
         SELECT id, rank() OVER (ORDER BY embedding <=> $2::vector) AS rank FROM chunks ORDER BY embedding <=> $2::vector LIMIT 50),
       full_match AS (
         SELECT id, ts_rank_cd(tsv, ${AND_QUERY}) AS score FROM chunks WHERE tsv @@ ${AND_QUERY} ORDER BY score DESC LIMIT 50),
       partial AS (
         SELECT id, ts_rank_cd(tsv, ${OR_QUERY}) AS score FROM chunks
         WHERE tsv @@ ${OR_QUERY} AND NOT EXISTS (SELECT 1 FROM full_match) ORDER BY score DESC LIMIT 50),
       keyword AS (SELECT id, rank() OVER (ORDER BY score DESC) AS rank FROM (SELECT * FROM full_match UNION ALL SELECT * FROM partial) k)
       SELECT id FROM semantic FULL OUTER JOIN keyword USING (id)
       ORDER BY COALESCE(1.0 / (60 + semantic.rank), 0) + COALESCE(1.0 / (60 + keyword.rank), 0) DESC LIMIT 5`,
      [q.query, toVectorLiteral(probe(q))],
    );
    return rows.map((r) => nameOf.get(r.id)!);
  });
const hybridWith = (tsq: string) => (q: GoldenQuery) =>
  withTenant(pool, TENANT, async (c) => {
    const { rows } = await c.query(
      `WITH semantic AS (
         SELECT id, rank() OVER (ORDER BY embedding <=> $2::vector) AS rank FROM chunks ORDER BY embedding <=> $2::vector LIMIT 50),
       keyword AS (
         SELECT id, rank() OVER (ORDER BY ts_rank_cd(tsv, ${tsq}) DESC) AS rank FROM chunks WHERE tsv @@ ${tsq} LIMIT 50)
       SELECT id FROM semantic FULL OUTER JOIN keyword USING (id)
       ORDER BY COALESCE(1.0 / (60 + semantic.rank), 0) + COALESCE(1.0 / (60 + keyword.rank), 0) DESC LIMIT 5`,
      [q.query, toVectorLiteral(probe(q))],
    );
    return rows.map((r) => nameOf.get(r.id)!);
  });
const withoutUnaccent = (q: GoldenQuery) =>
  withTenant(pool, TENANT, async (c) => {
    const { rows } = await c.query(
      `WITH semantic AS (
         SELECT id, rank() OVER (ORDER BY embedding <=> $1::vector) AS rank FROM chunks ORDER BY embedding <=> $1::vector LIMIT 50),
       keyword AS (
         SELECT id, rank() OVER (ORDER BY ts_rank_cd(tsv, websearch_to_tsquery('simple', $2)) DESC) AS rank
         FROM chunks WHERE tsv @@ websearch_to_tsquery('simple', $2) LIMIT 50)
       SELECT id FROM semantic FULL OUTER JOIN keyword USING (id)
       ORDER BY COALESCE(1.0 / (60 + semantic.rank), 0) + COALESCE(1.0 / (60 + keyword.rank), 0) DESC LIMIT 5`,
      [toVectorLiteral(probe(q)), q.query],
    );
    return rows.map((r) => nameOf.get(r.id)!);
  });

const baseline = await evaluateRetriever(KEYWORD_QUERIES, shipped);
const broken = await evaluateRetriever(KEYWORD_QUERIES, withoutUnaccent);
const verdict = compareReports(baseline, broken);
console.log(toMarkdown(baseline, broken, verdict), '\n');

const regression = [
  { run: 'hybrid search (shipped)', 'recall@5': baseline.recall, MRR: baseline.mrr, 'recall, accented': baseline.byTag.accents.recall, 'recall, unaccented': baseline.byTag['no-accents'].recall },
  { run: 'same, kit_unaccent dropped from the query', 'recall@5': broken.recall, MRR: broken.mrr, 'recall, accented': broken.byTag.accents.recall, 'recall, unaccented': broken.byTag['no-accents'].recall },
];
table(regression);

const queryForms: Array<Record<string, unknown>> = [];
for (const [run, retrieve] of [
  ['keyword retriever alone, AND of the words', keywordOnly(AND_QUERY)],
  ['keyword retriever alone, OR of the words', keywordOnly(OR_QUERY)],
  ['keyword retriever alone, AND, falling back to OR', keywordFallback],
  ['hybrid, AND keyword side (as shipped in 0.3.0)', hybridWith(AND_QUERY)],
  ['hybrid, OR keyword side', hybridWith(OR_QUERY)],
  ['hybrid, AND falling back to OR', hybridFallback],
  ['hybridSearch() as it ships now', shipped],
] as const) {
  const box = await evaluateRetriever(KEYWORD_QUERIES, retrieve);
  const questions = await evaluateRetriever(QUESTION_QUERIES, retrieve);
  queryForms.push({ run, 'search-box queries recall@5': box.recall, 'search-box MRR': box.mrr, 'questions recall@5': questions.recall, 'questions MRR': questions.mrr });
}
table(queryForms);
save('rag-evals', {
  chunks: Object.keys(CHUNKS).length,
  keywordQueries: KEYWORD_QUERIES.length,
  questionQueries: QUESTION_QUERIES.length,
  regression,
  gate: verdict,
  queryForms,
});
await pool.end();
