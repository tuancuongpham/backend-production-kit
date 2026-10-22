import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { fakeEmbedding, toVectorLiteral } from '../support/vectors.ts';
import { hybridSearch, withTenant } from '../../../skills/multitenant-postgres/references/tenant-db.ts';
import {
  compareReports,
  evaluateRetriever,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  toMarkdown,
  type GoldenQuery,
} from '../../../skills/rag-evals/references/retrieval-eval.ts';
import { cohensKappa, fillPrompt, judgeAgreement, runJudge, type JudgeCase } from '../../../skills/rag-evals/references/judge.ts';
import { CHUNKS, KEYWORD_QUERIES, TENANT } from '../fixtures/help-center.ts';

const golden: GoldenQuery[] = KEYWORD_QUERIES;

let pool: pg.Pool;
const nameOf = new Map<string, string>();

describe('rag-evals', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_rag_evals'), max: 4 });
    await runSqlFile(pool, 'multitenant-postgres', 'schema.sql');
    await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Shop')`, [TENANT]);
    const doc = (await pool.query(`INSERT INTO documents (tenant_id, title) VALUES ($1, 'Help center') RETURNING id`, [TENANT])).rows[0].id;
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
  });
  after(async () => pool?.end());

  // The query embedding is noise in this test (no embedding model), so keyword search carries retrieval.
  const shipped = (q: GoldenQuery) =>
    withTenant(pool, TENANT, (c) => hybridSearch(c, { embedding: fakeEmbedding(1000 + Number(q.id.slice(1))), query: q.query, limit: 5 })).then((hits) =>
      hits.map((h) => nameOf.get(h.id)!),
    );
  // The same query with kit_unaccent removed from the query side: an easy "cleanup" to make by mistake.
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
        [toVectorLiteral(fakeEmbedding(1000 + Number(q.id.slice(1)))), q.query],
      );
      return rows.map((r) => nameOf.get(r.id)!);
    });

  it('metrics: recall, precision, MRR and nDCG on hand-checked rankings', () => {
    const retrieved = ['x', 'a', 'y', 'b', 'z'];
    assert.equal(recallAtK(retrieved, ['a', 'b', 'c'], 5), 2 / 3);
    assert.equal(recallAtK(retrieved, ['a', 'b', 'c'], 2), 1 / 3);
    assert.equal(precisionAtK(retrieved, ['a', 'b'], 5), 0.4);
    assert.equal(reciprocalRank(retrieved, ['b', 'a']), 0.5);
    assert.equal(reciprocalRank(retrieved, ['q']), 0);
    assert.equal(ndcgAtK(['a', 'b'], ['a', 'b'], 5), 1);
    assert.ok(Math.abs(ndcgAtK(['x', 'a'], ['a'], 5) - 1 / Math.log2(3)) < 1e-12);
  });

  it('the gate catches a real regression in Postgres hybrid search: accented queries break when unaccent is dropped', async () => {
    const baseline = await evaluateRetriever(golden, shipped, 5);
    assert.equal(baseline.recall, 1, JSON.stringify(baseline.perQuery.filter((r) => r.recall < 1)));
    assert.equal(compareReports(baseline, await evaluateRetriever(golden, shipped, 5)).pass, true, 'the same code passes its own gate');

    const broken = await evaluateRetriever(golden, withoutUnaccent, 5);
    const verdict = compareReports(baseline, broken);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failures.some((f) => f.startsWith('recall in "accents" fell')), verdict.failures.join('; '));
    assert.equal(broken.byTag['no-accents'].recall, 1, 'queries typed without accents still work, so a spot check would pass');
    assert.ok(verdict.regressed.every((r) => /[^\p{ASCII}]/u.test(r.query)), 'only accented queries lost results');
    assert.match(toMarkdown(baseline, broken, verdict), /\*\*Retrieval eval: FAIL\*\*/);
  });

  it("Cohen's kappa matches worked examples", () => {
    assert.equal(cohensKappa(['p', 'f', 'p'], ['p', 'f', 'p']), 1);
    assert.equal(cohensKappa(['p', 'p', 'f', 'f'], ['p', 'f', 'f', 'f']), 0.5);
    assert.ok(Math.abs(cohensKappa(['p', 'f', 'p', 'f'], ['p', 'p', 'f', 'f'])) < 1e-12, 'chance-level agreement is 0');
  });

  it('a judge that looks accurate can still pass what humans fail: agreement is measured before its scores gate anything', async () => {
    const context = ['Hoàn tiền được xử lý trong 5–7 ngày làm việc.', 'Miễn phí vận chuyển cho đơn từ 300.000 đồng.', 'Bảo hành 12 tháng.'];
    const cases: JudgeCase[] = [
      { id: 'a', question: 'Bao lâu được hoàn tiền?', context, answer: 'Bạn được hoàn tiền trong 5–7 ngày làm việc.', human: 'pass' },
      { id: 'b', question: 'Bao lâu được hoàn tiền?', context, answer: 'Hoàn tiền trong 24 giờ.', human: 'fail' },
      { id: 'c', question: 'Phí vận chuyển?', context, answer: 'Đơn từ 300.000 đồng được miễn phí vận chuyển.', human: 'pass' },
      { id: 'd', question: 'Phí vận chuyển?', context, answer: 'Mọi đơn hàng đều được miễn phí vận chuyển.', human: 'fail' },
      { id: 'e', question: 'Bảo hành bao lâu?', context, answer: 'Bảo hành 12 tháng.', human: 'pass' },
      { id: 'f', question: 'Có trả góp không?', context, answer: 'Tôi chưa có thông tin này, bạn vui lòng liên hệ tổng đài.', human: 'pass' },
    ];
    // A cheap judge: fails answers containing a number the context doesn't have. It misses claims without numbers.
    const numberJudge = async (c: JudgeCase) => {
      const unsupported = (c.answer.match(/\d+/g) ?? []).filter((n) => !c.context.join(' ').includes(n));
      return { verdict: unsupported.length ? ('fail' as const) : ('pass' as const), reason: unsupported.join(', ') };
    };
    const { results, passRate } = await runJudge(cases, numberJudge);
    assert.equal(passRate, 5 / 6);
    const agreement = judgeAgreement(results);
    assert.equal(agreement.accuracy, 5 / 6);
    assert.equal(agreement.falsePasses, 1, '"every order ships free" passed');
    assert.ok(Math.abs(agreement.kappa - 0.571) < 0.001, `kappa ${agreement.kappa}: too low to gate on`);
    assert.match(fillPrompt(cases[1]), /\[1\] Hoàn tiền[\s\S]*Answer: Hoàn tiền trong 24 giờ\./);
  });
});
