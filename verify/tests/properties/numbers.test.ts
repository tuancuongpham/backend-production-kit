// Properties of the arithmetic the kit decides with: backoff delays, retrieval metrics, judge agreement, similarity,
// burn rates, rate-limit headers. Over generated numbers, results stay in their documented range, so a dashboard,
// a gate or a retry schedule never sees NaN, a negative delay, or a recall above 1.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fc } from '../support/arbitraries.ts';
import { backoffMs as webhookBackoff } from '../../../skills/webhook-ingestion/references/webhooks.ts';
import { backoffMs as jobBackoff } from '../../../skills/job-queue/references/jobs.ts';
import { compareReports, ndcgAtK, precisionAtK, recallAtK, reciprocalRank, type Report } from '../../../skills/rag-evals/references/retrieval-eval.ts';
import { cohensKappa } from '../../../skills/rag-evals/references/judge.ts';
import { cosineSimilarity } from '../../../skills/llm-gateway/references/gateway.ts';
import { burnAlerts, prometheusRules, simulate, WINDOWS, type Window } from '../../../skills/slo-alerting/references/slo.ts';
import { rateLimitHeaders } from '../../../skills/rate-limiting/references/limiter.ts';

const ids = fc.array(fc.constantFrom('d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'), { maxLength: 10 });
const unit = (x: number) => x >= 0 && x <= 1;

describe('properties: numbers', () => {
  it('backoff: between half and all of the capped exponential delay, for any attempt count, in webhooks and jobs alike', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 1, max: 60_000 }), fc.integer({ min: 1, max: 86_400_000 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (attempt, base, max, r) => {
        const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
        for (const backoff of [webhookBackoff, jobBackoff]) {
          const delay = backoff(attempt, base, max, () => r);
          assert.ok(Number.isInteger(delay) && delay >= Math.floor(exp / 2) && delay <= Math.ceil(exp), `${delay} for attempt ${attempt}`);
        }
      }),
    );
  });

  it('retrieval metrics: recall, precision, reciprocal rank and nDCG stay within 0..1, and recall@k never falls as k grows', () => {
    fc.assert(
      fc.property(ids, ids, fc.integer({ min: 1, max: 12 }), (retrieved, relevant, k) => {
        for (const m of [recallAtK(retrieved, relevant, k), precisionAtK(retrieved, relevant, k), reciprocalRank(retrieved, relevant), ndcgAtK(retrieved, relevant, k)]) {
          assert.ok(unit(m), `${m} for ${JSON.stringify({ retrieved, relevant, k })}`);
        }
        assert.ok(recallAtK(retrieved, relevant, k + 1) >= recallAtK(retrieved, relevant, k));
      }),
    );
  });

  it('retrieval metrics: a perfect ranking scores 1 on every metric', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom('d1', 'd2', 'd3', 'd4', 'd5'), { minLength: 1 }), (relevant) => {
        const k = relevant.length;
        assert.deepEqual([recallAtK(relevant, relevant, k), precisionAtK(relevant, relevant, k), reciprocalRank(relevant, relevant), ndcgAtK(relevant, relevant, k)], [1, 1, 1, 1]);
      }),
    );
  });

  it('rag gate: two runs with a different k are never compared as if they were the same metric', () => {
    const report = (k: number, recall: number): Report => ({
      k,
      queries: 1,
      recall,
      precision: 0,
      mrr: 1,
      ndcg: 1,
      hitRate: 1,
      byTag: {},
      perQuery: [{ id: 'q1', query: 'giao hàng mất bao lâu?', tags: [], retrieved: [], missed: [], recall, reciprocalRank: 1, ndcg: 1 }],
    });
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), fc.double({ min: 0, max: 1, noNaN: true }), (k1, k2, recall) => {
        fc.pre(k1 !== k2);
        assert.equal(compareReports(report(k1, recall), report(k2, Math.min(1, recall + 0.1))).pass, false);
      }),
    );
  });

  it("judge agreement: Cohen's kappa stays within -1..1, and a judge that agrees with every label scores 1", () => {
    const labels = fc.array(fc.constantFrom('pass', 'fail'), { minLength: 1, maxLength: 30 });
    fc.assert(
      fc.property(labels.chain((a) => fc.tuple(fc.constant(a), fc.array(fc.constantFrom('pass', 'fail'), { minLength: a.length, maxLength: a.length }))), ([a, b]) => {
        const kappa = cohensKappa(a, b);
        assert.ok(kappa >= -1 && kappa <= 1, `${kappa}`);
        assert.equal(cohensKappa(a, a), 1);
      }),
    );
  });

  it('cosine similarity: symmetric, within -1..1, and 1 for a vector with itself', () => {
    // Embedding components: 0, or between 1e-6 and 10 in size. (Subnormal doubles, around 1e-310, square to 0.)
    const component = fc.oneof(fc.constant(0), fc.double({ min: 1e-6, max: 10, noNaN: true }), fc.double({ min: -10, max: -1e-6, noNaN: true }));
    const pair = fc.integer({ min: 1, max: 16 }).chain((n) => fc.tuple(fc.array(component, { minLength: n, maxLength: n }), fc.array(component, { minLength: n, maxLength: n })));
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const s = cosineSimilarity(a, b);
        assert.equal(s, cosineSimilarity(b, a));
        assert.ok(s >= -1 - 1e-12 && s <= 1 + 1e-12, `${s}`);
        if (a.some((x) => x !== 0)) assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-12);
      }),
    );
  });

  it('slo: no errors never fires an alert; an error ratio above every threshold on both windows fires them all', () => {
    // From 0.931 up: below it, the 14.4x alert would need more than 100% errors, and prometheusRules refuses the SLO.
    const objective = fc.double({ min: 0.931, max: 0.9999, noNaN: true });
    fc.assert(
      fc.property(objective, (o) => {
        const zero = Object.fromEntries(WINDOWS.map((w) => [w, 0])) as Record<Window, number>;
        assert.ok(burnAlerts(o, zero).every((a) => !a.firing));
        const burning = Object.fromEntries(WINDOWS.map((w) => [w, Math.min(1, 15 * (1 - o))])) as Record<Window, number>;
        assert.ok(burnAlerts(o, burning).every((a) => a.firing), `objective ${o}`);
      }),
    );
  });

  it('slo: an objective too low for any burn alert to fire is refused, not turned into rules that can never page', () => {
    const errorRatio = 'sum(rate(errors[{{window}}])) / sum(rate(requests[{{window}}]))';
    fc.assert(
      fc.property(fc.double({ min: 0.5, max: 0.93, noNaN: true }), (o) => {
        assert.throws(() => prometheusRules([{ name: 'batch-jobs', service: 'worker', objective: o, errorRatio }]), /could never fire/);
      }),
    );
  });

  it('slo: replaying any traffic never throws, and an alert fires at a minute inside the replay or not at all', () => {
    const minute = fc.integer({ min: 0, max: 1000 }).chain((total) => fc.record({ total: fc.constant(total), errors: fc.integer({ min: 0, max: total }) }));
    fc.assert(
      fc.property(fc.double({ min: 0.9, max: 0.9999, noNaN: true }), fc.array(minute, { maxLength: 200 }), (o, minutes) => {
        for (const at of Object.values(simulate(o, minutes))) assert.ok(at === null || (Number.isInteger(at) && at >= 1 && at <= minutes.length));
      }),
    );
  });

  it('rate-limit headers: a refusal always says when to come back (at least 1 s), and remaining is never negative', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: -5, max: 100 }), fc.integer({ min: 0, max: 600_000 }), fc.integer({ min: 1, max: 1000 }), (allowed, remaining, retryAfterMs, capacity) => {
        const h = rateLimitHeaders({ allowed, remaining, retryAfterMs, source: 'redis' }, capacity);
        assert.ok(Number(h['RateLimit-Remaining']) >= 0);
        if (!allowed) assert.ok(Number(h['Retry-After']) >= 1);
        else assert.equal(h['Retry-After'], undefined);
      }),
    );
  });
});
