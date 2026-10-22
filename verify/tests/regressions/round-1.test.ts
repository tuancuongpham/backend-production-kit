// Regression tests for latent bugs found in a review of the reference code.
// Each test failed on the code before its fix; keep them so the bugs can't come back.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { createRedactor } from '../../../skills/pii-redaction/references/redact.ts';
import { createGateway, memoryBudget, type Provider } from '../../../skills/llm-gateway/references/gateway.ts';
import { createRateLimiter } from '../../../skills/rate-limiting/references/limiter.ts';
import pg from 'pg';
import { freshDatabase, REDIS_URL, runSqlFile, withUser } from '../support/infra.ts';
import { fakeEmbedding, toVectorLiteral } from '../support/vectors.ts';
import { sleep } from '../support/wait.ts';
import { createInboxWorker, ingest, type Handler } from '../../../skills/webhook-ingestion/references/webhooks.ts';
import { hybridSearch, withTenant } from '../../../skills/multitenant-postgres/references/tenant-db.ts';

describe('latent bugs', () => {
  it('pii-redaction: large log strings are redacted in linear time (no regex blow-up)', () => {
    const r = createRedactor({ maxStringLength: Number.MAX_SAFE_INTEGER }); // measure the regexes, not truncation
    const noAt = 'x'.repeat(50_000); // e.g. a big base64 blob or minified payload in a log line
    let t0 = performance.now();
    r.redactString(noAt);
    const msNoAt = performance.now() - t0;
    const manyAt = 'user@'.repeat(10_000);
    t0 = performance.now();
    r.redactString(manyAt);
    const msManyAt = performance.now() - t0;
    // Before the fix the unbounded email local part made this O(n²): seconds per call.
    assert.ok(msNoAt < 200, `50 KB without '@' took ${msNoAt.toFixed(0)} ms`);
    assert.ok(msManyAt < 200, `50 KB of '@' took ${msManyAt.toFixed(0)} ms`);
    assert.equal(r.redactString('mail a.b+c@example.com'), 'mail [EMAIL]', 'still redacts normal emails');
  });

  it('pii-redaction: oversized strings are truncated before scanning, PII in the kept part still redacted', () => {
    const r = createRedactor({ maxStringLength: 100 });
    const out = r.redactString(`card 4111 1111 1111 1111 ${'z'.repeat(500)}`);
    assert.ok(out.startsWith('card [CARD] '));
    assert.match(out, /…\[TRUNCATED 425 chars\]$/);
  });

  it('llm-gateway: a model missing from the price table is a configuration error when budgets are on', () => {
    const p: Provider = { name: 'p', model: 'not-in-price-table', complete: async () => ({ content: '', usage: { inputTokens: 1, outputTokens: 1 } }) };
    // Before the fix the estimate and cost were silently $0, so the budget never limited anything.
    assert.throws(
      () => createGateway({ providers: [p], prices: {}, budget: { store: memoryBudget(), monthlyLimitUsd: () => 1 } }),
      /price/i,
    );
  });

  it('llm-gateway: a call that crosses a month boundary settles the month it reserved in', async () => {
    let clock = Date.parse('2026-01-31T23:59:59.900Z');
    const store = memoryBudget();
    const p: Provider = {
      name: 'p',
      model: 'unit',
      async complete() {
        clock = Date.parse('2026-02-01T00:00:00.100Z'); // the month rolls over while the model is generating
        return { content: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 0 } }; // $1
      },
    };
    const gw = createGateway({
      providers: [p],
      prices: { unit: { inputPer1M: 1, outputPer1M: 0 } },
      budget: { store, monthlyLimitUsd: () => 10, estimateUsd: () => 2 },
      now: () => clock,
    });
    await gw.chat({ messages: [{ role: 'user', content: 'hi' }] }, { tenantId: 't' });
    // Before the fix the $2 reservation stayed stuck in January forever, shrinking that month's budget.
    assert.deepEqual(store.snapshot('t', '2026-01'), { spent: 1, reserved: 0 });
    assert.deepEqual(store.snapshot('t', '2026-02'), { spent: 0, reserved: 0 });
  });

  it('rate-limiting: a busy subject keeps its local bucket under key churn (LRU, not insertion order)', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on('error', () => {});
    const rl = createRateLimiter({ redis: dead, capacity: 1, refillPerSec: 1e-9, failureMode: 'local', breakerThreshold: 1, breakerCooldownMs: 60_000 });
    assert.equal((await rl.check('hot')).allowed, true); // the hot subject spends its only token
    let hotAllowedAgain = 0;
    for (let i = 0; i < 52_000; i++) {
      await rl.check(`cold-${i}`); // churn: many one-off subjects (scanners, random IPs)
      if (i % 1000 === 0 && (await rl.check('hot')).allowed) hotAllowedAgain++;
    }
    dead.disconnect();
    // Before the fix the hot key was evicted first (oldest insertion) and came back with a full bucket.
    assert.equal(hotAllowedAgain, 0);
  });
});

describe('performance changes keep their guarantees', () => {
  it('rate-limiting: EVALSHA path recovers after the script cache is flushed (restart / failover)', async () => {
    const redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 500, lazyConnect: true });
    await redis.connect();
    try {
      const rl = createRateLimiter({ redis, capacity: 2, refillPerSec: 1e-9, failureMode: 'closed', keyPrefix: `sha${Date.now()}`, timeoutMs: 500 });
      assert.equal((await rl.check('a')).source, 'redis');
      await redis.script('FLUSH'); // what a Redis restart or failover to a replica looks like
      const r = await rl.check('a');
      assert.deepEqual([r.source, r.allowed], ['redis', true]);
      assert.equal((await rl.check('a')).allowed, false, 'bucket state survived; only the script cache was lost');
    } finally {
      redis.disconnect();
    }
  });

  it('webhook-ingestion: concurrency > 1 drains faster and still applies every event exactly once', async () => {
    const pool = new pg.Pool({ connectionString: await freshDatabase('kit_webhook_concurrency'), max: 20 });
    try {
      await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
      await pool.query(`CREATE TABLE credits (event_id text PRIMARY KEY)`);
      const slowCredit: Handler = async (row, tx) => {
        await sleep(20); // I/O-bound handler, e.g. a provider API call
        await tx.query(`INSERT INTO credits VALUES ($1)`, [row.event_id]);
      };
      const drain = async (concurrency: number, prefix: string) => {
        for (let i = 0; i < 40; i++) await ingest(pool, { provider: 'stripe', eventId: `${prefix}${i}`, eventType: 'payment.succeeded', payload: {} });
        const workers = [1, 2].map(() => createInboxWorker({ pool, batchSize: 20, concurrency, handlers: { 'stripe:payment.succeeded': slowCredit } }));
        const t0 = performance.now();
        await Promise.all(workers.map(async (w) => { while ((await w.processOnce()).length > 0); }));
        return performance.now() - t0;
      };
      const sequentialMs = await drain(1, 'seq_');
      const parallelMs = await drain(8, 'par_');
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM credits`);
      assert.equal(rows[0].n, 80, 'every event applied once (a duplicate would hit the primary key)');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM webhook_inbox WHERE status <> 'done'`)).rows[0].n, 0);
      assert.ok(parallelMs < sequentialMs / 2, `concurrency 8: ${parallelMs.toFixed(0)} ms vs sequential ${sequentialMs.toFixed(0)} ms`);
    } finally {
      await pool.end();
    }
  });

  it('multitenant-postgres: iterative HNSW scan is enabled even on a brand-new connection', async () => {
    const dbUrl = await freshDatabase('kit_hnsw_guard');
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    await runSqlFile(admin, 'multitenant-postgres', 'schema.sql');
    await admin.query(`ALTER ROLE app_user PASSWORD 'app-test-pw'`);
    const tenant = '33333333-3333-4333-8333-333333333333';
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Gamma')`, [tenant]);
    await admin.end();
    const pool = new pg.Pool({ connectionString: withUser(dbUrl, 'app_user', 'app-test-pw'), max: 1 });
    try {
      const setting = await withTenant(pool, tenant, async (c) => {
        const doc = (await c.query(`INSERT INTO documents (title) VALUES ('d') RETURNING id`)).rows[0].id;
        await c.query(`INSERT INTO chunks (document_id, content, embedding) VALUES ($1, 'xin chào', $2)`, [doc, toVectorLiteral(fakeEmbedding(7))]);
        await hybridSearch(c, { embedding: fakeEmbedding(7), query: 'xin chao' });
        return (await c.query(`SELECT current_setting('hnsw.iterative_scan') AS v`)).rows[0].v;
      });
      assert.equal(setting, 'relaxed_order');
      // And again on the now-reused pooled connection (where a reserved-prefix error used to bite).
      const hits = await withTenant(pool, tenant, (c) => hybridSearch(c, { embedding: fakeEmbedding(7), query: 'xin chao' }));
      assert.equal(hits.length, 1);
    } finally {
      await pool.end();
    }
  });
});
