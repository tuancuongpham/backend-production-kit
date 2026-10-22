import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { fakeEmbedding } from '../support/vectors.ts';
import { sleep } from '../support/wait.ts';
import { createGateway, type Provider } from '../../../skills/llm-gateway/references/gateway.ts';
import { pgBudget, pgCache, pgUsageSink } from '../../../skills/llm-gateway/references/pg-stores.ts';

let pool: pg.Pool;
const value = { content: 'cached answer', model: 'm', provider: 'p' };

describe('llm-gateway (Postgres stores)', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_llm_gateway') });
    await runSqlFile(pool, 'llm-gateway', 'semantic-cache.sql');
  });
  after(async () => pool?.end());

  it('exact cache round-trips and expires', async () => {
    const c = pgCache(pool);
    await c.setExact('k1', value, 60);
    assert.deepEqual(await c.getExact('k1'), value);
    await c.setExact('k2', value, 0.2);
    await sleep(300);
    assert.equal(await c.getExact('k2'), null);
  });

  it('semantic cache: threshold and scope are enforced', async () => {
    const c = pgCache(pool);
    const v = fakeEmbedding(1);
    await c.saveSimilar('scope-a', v, value, 60);
    const near = v.map((x, i) => (i === 0 ? x + 0.01 : x));
    const hit = await c.findSimilar('scope-a', near, 0.95);
    assert.ok(hit && hit.similarity > 0.99);
    assert.equal(await c.findSimilar('scope-a', fakeEmbedding(2), 0.95), null, 'unrelated vector misses');
    assert.equal(await c.findSimilar('scope-b', v, 0.95), null, 'other scope misses');
  });

  it("semantic cache with the HNSW index ('ann', for very large scopes): the same threshold and scope rules", async () => {
    const c = pgCache(pool, { semanticSearch: 'ann' });
    const v = fakeEmbedding(7);
    await c.saveSimilar('scope-ann', v, value, 60);
    for (let i = 0; i < 50; i++) await c.saveSimilar('scope-noise', fakeEmbedding(100 + i), value, 60); // other tenants' entries
    const hit = await c.findSimilar('scope-ann', v.map((x, i) => (i === 0 ? x + 0.01 : x)), 0.95);
    assert.ok(hit && hit.similarity > 0.99, 'found through the index, past the other scopes');
    assert.equal(await c.findSimilar('scope-ann', fakeEmbedding(8), 0.95), null);
    assert.equal(await c.findSimilar('scope-other', v, 0.95), null);
  });

  it('budget reservations are atomic across app instances; the ledger records every call', async () => {
    const provider: Provider = {
      name: 'p',
      model: 'big',
      complete: async () => {
        await sleep(30);
        return { content: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 0 } }; // $5
      },
    };
    const sink = pgUsageSink(pool);
    const pending: Promise<unknown>[] = [];
    // Two gateways with their own pools ≈ two app instances sharing one database.
    const pool2 = new pg.Pool({ connectionString: (pool as any).options.connectionString });
    const make = (p: pg.Pool) =>
      createGateway({
        providers: [provider],
        prices: { big: { inputPer1M: 5, outputPer1M: 0 } },
        budget: { store: pgBudget(p), monthlyLimitUsd: () => 15, estimateUsd: () => 5 },
        onUsage: (u) => void pending.push(sink(u)),
      });
    const instances = [make(pool), make(pool2)];
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        instances[i % 2].chat({ messages: [{ role: 'user', content: `q${i}` }] }, { tenantId: 'acme', feature: 'support-chat' }),
      ),
    );
    await Promise.all(pending);
    await pool2.end();
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3, '$15 limit / $5 per call');
    const budget = (await pool.query(`SELECT spent_usd::float8 AS spent, reserved_usd::float8 AS reserved FROM llm_budget WHERE tenant_id = 'acme'`)).rows[0];
    assert.deepEqual(budget, { spent: 15, reserved: 0 });
    const { rows } = await pool.query(`SELECT ok, count(*)::int AS n, sum(cost_usd)::float8 AS usd FROM llm_usage WHERE tenant_id = 'acme' GROUP BY ok ORDER BY ok`);
    assert.deepEqual(rows, [
      { ok: false, n: 5, usd: 0 },
      { ok: true, n: 3, usd: 15 },
    ]);
  });
});
