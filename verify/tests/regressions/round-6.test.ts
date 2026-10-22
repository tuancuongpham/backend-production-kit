// Round 6 of the latent-bug review: numbers that arrive as NaN (an unset environment variable, a plan missing from a
// table, a provider answer without token counts), secrets under the names apps give them, one failure that stops the
// work beside it, a deploy's drain, and a cache write that lands after its invalidation.
// Each hypothesis is a test of the behaviour the skill promises. Namespace imports keep this file loadable against
// older code.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { Redis } from 'ioredis';
import { freshDatabase, REDIS_URL, runSqlFile } from '../support/infra.ts';
import { fakeEmbedding } from '../support/vectors.ts';
import { sleep } from '../support/wait.ts';
import { Gate } from '../support/gate.ts';
import { withTimeout } from '../../../shared/with-timeout.ts';
import * as loops from '../../../shared/worker-loop.ts';
import * as server from '../../../skills/service-hardening/references/server.ts';
import * as limiter from '../../../skills/rate-limiting/references/limiter.ts';
import * as cache from '../../../skills/cache-stampede/references/cache.ts';
import * as gateway from '../../../skills/llm-gateway/references/gateway.ts';
import * as pgStores from '../../../skills/llm-gateway/references/pg-stores.ts';
import * as jobs from '../../../skills/job-queue/references/jobs.ts';
import * as webhooks from '../../../skills/webhook-ingestion/references/webhooks.ts';
import * as migrate from '../../../skills/zero-downtime-migrations/references/migrate.ts';
import * as lint from '../../../skills/zero-downtime-migrations/references/lint.ts';
import * as agentDb from '../../../skills/agent-safe-db/references/agent-db-tool.ts';
import * as erasure from '../../../skills/data-retention-and-erasure/references/erasure.ts';
import * as sse from '../../../skills/sse-streaming/references/sse.ts';
import * as evals from '../../../skills/rag-evals/references/retrieval-eval.ts';
import * as redaction from '../../../skills/pii-redaction/references/redact.ts';
import * as toolGuard from '../../../skills/llm-tool-safety/references/tool-guard.ts';
import * as slo from '../../../skills/slo-alerting/references/slo.ts';

const TENANT = '66666666-6666-4666-8666-666666666666';
/** What `Number(process.env.X)` gives when a deploy forgot the variable. */
const UNSET = Number(process.env.KIT_ROUND6_NEVER_SET);
let dbUrl: string;
let pool: pg.Pool;

/** Runs `fn`, then returns the promise rejections nobody handled: each one would end a real process. */
async function unhandledRejectionsDuring(fn: () => Promise<unknown>, settleMs = 100): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => void seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await fn();
    await sleep(settleMs);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

/** A hypothesis whose bug is a hang fails after `ms` instead of stalling the suite. */
const within = <T>(ms: number, p: Promise<T>) => withTimeout(p, ms, () => new Error(`still waiting after ${ms} ms`));

describe('latent bugs, round 6: configuration, accounting, secrets, isolation and deploys', () => {
  before(async () => {
    dbUrl = await freshDatabase('kit_round6');
    pool = new pg.Pool({ connectionString: dbUrl, max: 8 });
    pool.on('error', () => {});
    for (const [skill, file] of [
      ['llm-tool-safety', 'tool-guard.sql'],
      ['job-queue', 'jobs.sql'],
      ['llm-gateway', 'semantic-cache.sql'],
      ['data-retention-and-erasure', 'erasure.sql'],
    ]) {
      await runSqlFile(pool, skill, file);
    }
  });
  after(async () => pool?.end());

  // ---------- A number read from an unset environment variable is NaN, and NaN turns a limit off ----------

  describe('an option that is NaN is refused at startup, instead of quietly turning its limit off', () => {
    const fakeRedis = {} as Redis;
    const fakePool = {} as pg.Pool;
    const refused = (label: string, make: () => unknown) => assert.throws(make, RangeError, label);

    it('worker loops: loops: NaN ran no loop at all, and idleMs: NaN polled every millisecond', async () => {
      let ticks = 0;
      const tick = async () => (ticks++, false);
      await assert.rejects(loops.runLoops({ tick, signal: AbortSignal.timeout(100), loops: UNSET }), RangeError);
      await assert.rejects(loops.runLoops({ tick, signal: AbortSignal.timeout(100), idleMs: UNSET }), RangeError);
      assert.equal(ticks, 0);
    });

    it('service-hardening: maxInFlight, drainDelayMs and shutdownGraceMs (NaN shed nothing, drained nothing, cut every request at once)', () => {
      for (const option of ['maxInFlight', 'drainDelayMs', 'shutdownGraceMs', 'headersTimeoutMs', 'rejectLingerMs'] as const) {
        refused(option, () => server.createHardenedServer({ handler: () => {}, [option]: UNSET }));
      }
    });

    it('rate-limiting: timeoutMs and instances (a NaN timeout sent every check to the failure mode: with "open", no limit at all)', () => {
      const base = { redis: fakeRedis, capacity: 10, refillPerSec: 1, failureMode: 'open' as const };
      refused('timeoutMs', () => limiter.createRateLimiter({ ...base, timeoutMs: UNSET }));
      refused('instances', () => limiter.createRateLimiter({ ...base, failureMode: 'local', instances: UNSET }));
    });

    it('cache-stampede: timeoutMs, staleSec, jitter, lockMs and waitMs (each NaN switched the cache off, one way or another)', () => {
      for (const option of ['timeoutMs', 'staleSec', 'jitter', 'lockMs', 'waitMs'] as const) {
        refused(option, () => cache.createCache({ redis: fakeRedis, prefix: 'r6', ttlSec: 60, [option]: UNSET }));
      }
    });

    it('llm-gateway: timeoutMs, cache TTLs, and a semantic threshold written as a percentage (95 never matches anything)', () => {
      const base = { providers: [{ name: 'p', model: 'm', complete: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }) }], prices: {} };
      refused('timeoutMs', () => gateway.createGateway({ ...base, timeoutMs: UNSET }));
      refused('cacheTtlSec', () => gateway.createGateway({ ...base, cacheTtlSec: UNSET }));
      refused('fallbackCacheTtlSec', () => gateway.createGateway({ ...base, fallbackCacheTtlSec: UNSET }));
      refused('semanticThreshold 95', () => gateway.createGateway({ ...base, semanticThreshold: 95 }));
    });

    it('job-queue and webhook-ingestion: retry delays (NaN failed every retry, and with it the rescue of expired leases)', () => {
      refused('jobs baseDelayMs', () => jobs.createWorker({ pool: fakePool, handlers: {}, baseDelayMs: UNSET }));
      refused('jobs maxDelayMs', () => jobs.createWorker({ pool: fakePool, handlers: {}, maxDelayMs: UNSET }));
      refused('webhooks baseDelayMs', () => webhooks.createInboxWorker({ pool: fakePool, handlers: {}, baseDelayMs: UNSET }));
      refused('webhooks maxDelayMs', () => webhooks.createInboxWorker({ pool: fakePool, handlers: {}, maxDelayMs: UNSET }));
    });

    it('webhook-ingestion: a toleranceSec of NaN accepted a signature captured a year ago', () => {
      const t = 1_790_000_000;
      const body = '{"id":"evt_r6"}';
      const header = `t=${t},v1=${createHmac('sha256', 'whsec_r6').update(`${t}.${body}`).digest('hex')}`;
      refused('toleranceSec', () =>
        webhooks.verifyTimestampedSignature({ secret: 'whsec_r6', rawBody: body, header, toleranceSec: UNSET, nowSec: t + 365 * 86_400 }),
      );
    });

    it('agent-safe-db, data-retention, pii-redaction: row caps, pool sizes, deadlines and the per-line work bound', () => {
      const db = { connectionString: 'postgres://nobody@127.0.0.1:1/none', tools: {}, audit: () => {} };
      refused('maxRows', () => agentDb.createAgentDb({ ...db, maxRows: UNSET }));
      refused('poolSize', () => agentDb.createAgentDb({ ...db, poolSize: UNSET }));
      refused('connectTimeoutMs', () => agentDb.createAgentDb({ ...db, connectTimeoutMs: UNSET }));
      refused('dueDays', () => erasure.createDataLifecycle({ pool: fakePool, inventory: [], pepper: 'p', dueDays: UNSET }));
      refused('leaseSec', () => erasure.createDataLifecycle({ pool: fakePool, inventory: [], pepper: 'p', leaseSec: UNSET }));
      const store = (name: string): erasure.ExternalStore => ({ name, erase: async () => {} });
      refused('store timeouts past the lease', () =>
        erasure.createDataLifecycle({ pool: fakePool, inventory: [], pepper: 'p', stores: [store('search'), store('cache')], storeTimeoutMs: 200_000, leaseSec: 300 }),
      );
      refused('maxStringLength', () => redaction.createRedactor({ maxStringLength: UNSET }));
      refused('maxDepth', () => redaction.createRedactor({ maxDepth: UNSET }));
    });

    it('rag-evals: a gate threshold of NaN let every regression through', () => {
      const report = (recall: number): evals.Report => ({
        k: 5, queries: 1, recall, precision: recall, mrr: recall, ndcg: recall, hitRate: recall, byTag: {},
        perQuery: [{ id: 'q1', query: 'hủy đơn', tags: [], retrieved: [], missed: [], recall, reciprocalRank: recall, ndcg: recall }],
      });
      refused('maxRecallDrop', () => evals.compareReports(report(1), report(0), { maxRecallDrop: UNSET }));
    });

    it('sse-streaming: heartbeatMs (NaN pinged every millisecond), maxBufferedBytes and maxQueue (NaN never dropped a stalled client)', async () => {
      const errors: Record<string, unknown> = {};
      const srv = http.createServer(async (req, res) => {
        const option = new URL(req.url ?? '/', 'http://x').searchParams.get('option')!;
        try {
          if (option === 'maxQueue') {
            await sse.serveFeed(sse.openSse(req, res), sse.createReplayBuffer(), { maxQueue: UNSET });
          } else {
            sse.openSse(req, res, { [option]: UNSET });
          }
        } catch (err) {
          errors[option] = err;
        }
        res.end();
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      const port = (srv.address() as AddressInfo).port;
      try {
        for (const option of ['heartbeatMs', 'maxBufferedBytes', 'maxQueue']) {
          await fetch(`http://127.0.0.1:${port}/?option=${option}`, { signal: AbortSignal.timeout(300) }).then((r) => r.body?.cancel(), () => {});
          await sleep(20);
          assert.ok(errors[option] instanceof RangeError, option);
        }
      } finally {
        srv.closeAllConnections();
        srv.close();
      }
    });

    it('zero-downtime-migrations: attempts and retries of NaN retried forever, and batchSize 0 "finished" a backfill that did nothing', async () => {
      await pool.query(`CREATE TABLE r6_accounts (id bigserial PRIMARY KEY, plan text); INSERT INTO r6_accounts (plan) VALUES ('pro')`);
      await assert.rejects(migrate.runStep(pool, { name: 'noop', sql: 'SELECT 1' }, { attempts: UNSET }), RangeError);
      await assert.rejects(migrate.backfill(pool, { table: 'r6_accounts', set: `plan = upper(plan)`, retries: UNSET }), RangeError);
      await assert.rejects(migrate.backfill(pool, { table: 'r6_accounts', set: `plan = upper(plan)`, batchSize: 0 }), RangeError);
      assert.equal((await pool.query(`SELECT plan FROM r6_accounts`)).rows[0].plan, 'pro', 'nothing ran');
    });

    it('job-queue: a priority outside smallint, or maxAttempts beyond int, is a RangeError, not a database error', async () => {
      await assert.rejects(jobs.enqueue(pool, { kind: 'r6', priority: 40_000 }), RangeError);
      await assert.rejects(jobs.enqueue(pool, { kind: 'r6', maxAttempts: 3_000_000_000 }), RangeError);
    });
  });

  // ---------- Money is counted in numbers that exist ----------

  describe('llm-gateway: a budget is a control, and it fails closed', () => {
    const prices = { 'model-a': { inputPer1M: 3, outputPer1M: 15 } };
    const ask: gateway.ChatRequest = { messages: [{ role: 'user', content: 'Đơn hàng của tôi đâu?' }] };
    const provider = (usage: unknown, calls = { n: 0 }): gateway.Provider => ({
      name: 'primary',
      model: 'model-a',
      complete: async () => {
        calls.n++;
        return { content: 'Đơn của bạn đang được giao.', usage: usage as gateway.Usage };
      },
    });

    it('a monthly limit of NaN (a plan missing from the table) refuses the call, in memory and in Postgres', async () => {
      for (const [name, store] of [['memory', gateway.memoryBudget()], ['postgres', pgStores.pgBudget(pool)]] as const) {
        const calls = { n: 0 };
        const gw = gateway.createGateway({
          providers: [provider({ inputTokens: 10, outputTokens: 10 }, calls)],
          prices,
          budget: { store, monthlyLimitUsd: () => UNSET },
        });
        await assert.rejects(gw.chat(ask, { tenantId: `r6-nan-limit-${name}` }), name);
        assert.equal(calls.n, 0, `${name}: the model was never called`);
      }
    });

    it('an answer without token counts books the reserved estimate: the request succeeds, and the spend stays a number', async () => {
      const usage: gateway.UsageRecord[] = [];
      const stages: string[] = [];
      const make = (u: unknown) =>
        gateway.createGateway({
          providers: [provider(u)],
          prices,
          budget: { store: pgStores.pgBudget(pool), monthlyLimitUsd: () => 10 },
          onUsage: (r) => void usage.push(r),
          onError: (_err, stage) => void stages.push(stage),
        });
      const tenantId = 'r6-no-usage';
      // A streamed answer some SDKs return without usage, then one whose input count is missing.
      for (const u of [undefined, { inputTokens: undefined, outputTokens: 12 }, { inputTokens: 40, outputTokens: 12 }]) {
        assert.equal((await make(u).chat(ask, { tenantId })).content, 'Đơn của bạn đang được giao.');
      }
      const { rows } = await pool.query(`SELECT spent_usd::float8 AS spent, reserved_usd::float8 AS reserved FROM llm_budget WHERE tenant_id = $1`, [tenantId]);
      assert.ok(Number.isFinite(rows[0].spent) && rows[0].spent > 0, `spent ${rows[0].spent}`);
      assert.equal(rows[0].reserved, 0);
      assert.ok(usage.every((u) => Number.isFinite(u.costUsd) && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens)));
      assert.deepEqual(stages, ['usage', 'usage'], 'both unusable answers are reported');
    });

    it("a semantic cache hit doesn't hand the caller the question another user asked", async () => {
      const embed = async (text: string) => fakeEmbedding(/refund|hoàn tiền/i.test(text) ? 1 : 2);
      const gw = gateway.createGateway({ providers: [provider({ inputTokens: 1, outputTokens: 1 })], prices, cache: gateway.memoryCache(), embed, semanticMode: 'serve' });
      const ctx = (userId: string) => ({ tenantId: 'shop-1', userId });
      await gw.chat({ messages: [{ role: 'user', content: 'Tôi là Nguyễn Văn A, đơn 123 giao tới 12 Lý Thường Kiệt: làm sao hoàn tiền?' }] }, ctx('a'));
      const hit = await gw.chat({ messages: [{ role: 'user', content: 'how do I get a refund' }] }, ctx('b'));
      assert.equal(hit.cache, 'semantic');
      assert.equal(hit.question, undefined);
      assert.ok(!JSON.stringify(hit).includes('Nguyễn'));
    });
  });

  // ---------- Secrets under the names apps give them ----------

  describe('pii-redaction: secrets under the names apps give them', () => {
    const r = redaction.createRedactor();

    it('camelCase, prefixed and header-style secret names are redacted by name; names that only look alike are kept', () => {
      const secrets = {
        clientSecret: 'cs_9f8e7d6c5b4a',
        newPassword: 'Hunter2!2026',
        password_confirmation: 'Hunter2!2026',
        passwordHash: '$2b$12$R9h/cIPz0gi.URNNX3kh2O',
        idToken: 'opaque-id-token-value',
        sessionToken: 'st-1234567890',
        'x-auth-token': 'abc123def456',
        'proxy-authorization': 'Digest username="svc"',
        secret_key: 'abcdef123456',
        aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY',
        webhookSecret: 'plain-shared-secret',
        credentials: { user: 'svc', pass: 'p' },
      };
      for (const [key, value] of Object.entries(r.redactValue(secrets) as Record<string, unknown>)) assert.equal(value, '[REDACTED]', key);
      const lookalikes = { inputTokens: 1200, outputTokens: 300, max_tokens: 1024, cacheKey: 'product:42', sortKey: 'created_at', publicKey: 'pk-public', keyId: 'k-1', tokenizer: 'cl100k', secretName: 'db-credentials' };
      assert.deepEqual(r.redactValue(lookalikes), lookalikes);
    });

    it('a value with toJSON (a URL with credentials, a Decimal) is redacted as JSON would print it, not logged as {}', () => {
      const out = r.redactValue({ dsn: new URL('postgres://app:s3cret@db.internal:5432/shop'), total: { toJSON: () => '1250000.50' } });
      assert.deepEqual(out, { dsn: 'postgres://[URL_CREDENTIALS]@db.internal:5432/shop', total: '1250000.50' });
    });
  });

  // ---------- One failure must not stop the work beside it ----------

  it('job-queue: a schedule whose next() fails (an impossible cron expression) is reported, and the others still fire', async () => {
    const reported: string[] = [];
    let flakyCalls = 0;
    const scheduler = jobs.createScheduler({
      pool,
      schedules: [
        { name: 'r6-hourly', kind: 'report', next: jobs.every(3_600_000) },
        { name: 'r6-feb-31', kind: 'report', next: () => new Date(Number.NaN) }, // "0 0 31 2 *": that day never comes
        {
          name: 'r6-flaky',
          kind: 'report',
          next: (after) => {
            if (++flakyCalls > 1) throw new Error('cron parser failed');
            return jobs.every(3_600_000)(after);
          },
        },
      ],
      onError: (_err, schedule) => void reported.push(schedule),
    });
    assert.deepEqual(await scheduler.tick(), []);
    await pool.query(`UPDATE job_schedules SET next_run_at = now() - interval '1 minute' WHERE name LIKE 'r6-%'`);
    assert.deepEqual(await scheduler.tick(), ['r6-hourly']);
    assert.deepEqual([...new Set(reported)].sort(), ['r6-feb-31', 'r6-flaky']);
  });

  it('data-retention: an external store that never answers is timed out: the deletion request returns, the store stays pending', async () => {
    const lifecycle = erasure.createDataLifecycle({
      pool,
      inventory: [],
      pepper: 'r6-pepper',
      stores: [{ name: 'search', erase: () => new Promise<void>(() => {}) }], // a black-holed search cluster
      storeTimeoutMs: 200,
    });
    const res = await within(3_000, lifecycle.requestErasure('u-r6'));
    assert.deepEqual(res.pendingStores, ['search']);
    await pool.query(`UPDATE erasure_requests SET locked_until = now() - interval '1 second'`);
    assert.deepEqual(await within(3_000, lifecycle.processPending()), { completed: 0, open: 1 });
  });

  it('agent-safe-db: an audit sink that rejects fails the call, and is never an unhandled rejection', async () => {
    const db = agentDb.createAgentDb({
      connectionString: dbUrl,
      tools: { ping: { description: 'Ping', sql: 'SELECT 1 AS one', params: [] } },
      audit: async () => {
        throw new Error('audit table unreachable');
      },
    });
    try {
      const unhandled = await unhandledRejectionsDuring(() =>
        assert.rejects(db.run('ping', {}, { tenantId: TENANT, userId: 'u1' }), /audit table unreachable/),
      );
      assert.deepEqual(unhandled, []);
    } finally {
      await db.close();
    }
  });

  it('llm-tool-safety: an approved call whose run failed (the payment API answered 503) can be retried with the same approval', async () => {
    let attempts = 0;
    const refund: toolGuard.ToolDef = {
      name: 'refund',
      tier: 'destructive',
      description: 'Refund an order',
      params: { orderId: { type: 'string', required: true } },
      run: async () => {
        if (++attempts === 1) throw new Error('payment API 503');
        return { refunded: true };
      },
    };
    const guard = toolGuard.createToolGuard({ pool, tools: [refund] });
    const s = guard.session({ tenantId: 't1', userId: 'u1', sessionId: 'r6-approval' });
    const args = { orderId: 'o-1' };
    const ask = (await s.call('refund', args, { toolCallId: 'call-r6' })) as { approvalId: string };
    assert.equal(await guard.decide(ask.approvalId, { tenantId: 't1', userId: 'u1' }, 'approved'), true);
    assert.equal((await s.call('refund', args, { toolCallId: 'call-r6', approvalId: ask.approvalId })).status, 'error');
    assert.deepEqual(await s.call('refund', args, { toolCallId: 'call-r6', approvalId: ask.approvalId }), { status: 'ok', result: { refunded: true } });
    assert.equal(attempts, 2);
  });

  // ---------- A deploy ----------

  describe('service-hardening: a deploy', () => {
    it('during the drain delay, a request the load balancer still sends is served, with Connection: close', async () => {
      const srv = server.createHardenedServer({ handler: (_req, res) => void res.end('ok'), drainDelayMs: 300, shutdownGraceMs: 1_000 });
      const port = await srv.listen(0, '127.0.0.1');
      const done = srv.shutdown();
      await sleep(50);
      const res = await fetch(`http://127.0.0.1:${port}/orders`);
      assert.deepEqual([res.status, res.headers.get('connection'), await res.text()], [200, 'close', 'ok']);
      assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503, 'readiness still tells the load balancer to stop');
      assert.deepEqual(await done, { forced: false });
    });

    it('listen() on a port in use rejects with EADDRINUSE instead of crashing the process', async () => {
      const a = server.createHardenedServer({ handler: () => {}, drainDelayMs: 0 });
      const port = await a.listen(0, '127.0.0.1');
      try {
        const b = server.createHardenedServer({ handler: () => {}, drainDelayMs: 0 });
        await within(2_000, assert.rejects(b.listen(port, '127.0.0.1'), { code: 'EADDRINUSE' }));
      } finally {
        await a.shutdown();
      }
    });
  });

  // ---------- A cache write that lands after its invalidation ----------

  describe('cache-stampede: a value read before a change is never cached after the invalidation', () => {
    let redis: Redis;
    before(() => {
      redis = new Redis(REDIS_URL);
    });
    after(async () => {
      await redis.quit();
    });

    it('a fill that read the old row before the commit does not overwrite the invalidation', async () => {
      const c = cache.createCache({ redis, prefix: `r6:${randomUUID()}`, ttlSec: 60 });
      const row = { price: 100 };
      const slowRead = new Gate();
      const first = c.get('price:42', async () => {
        const seen = { ...row };
        await slowRead.pass();
        return seen;
      });
      await slowRead.reached;
      row.price = 90; // the update commits…
      await c.invalidate('price:42'); // …and invalidates, while the slow read still holds the old row
      slowRead.open();
      assert.deepEqual(await first, { price: 100 }, 'that request read before the commit');
      assert.deepEqual(await c.get('price:42', async () => ({ ...row })), { price: 90 });
    });

    it('a background refresh that read the old row does not overwrite the invalidation either', async () => {
      const c = cache.createCache({ redis, prefix: `r6:${randomUUID()}`, ttlSec: 0.05, staleSec: 60 });
      const row = { stock: 5 };
      await c.get('stock:7', async () => ({ ...row }));
      await sleep(80); // stale now: the next read answers at once and refreshes in the background
      const slowRefresh = new Gate();
      assert.deepEqual(
        await c.get('stock:7', async () => {
          const seen = { ...row };
          await slowRefresh.pass();
          return seen;
        }),
        { stock: 5 },
      );
      await slowRefresh.reached;
      row.stock = 0;
      await c.invalidate('stock:7');
      slowRefresh.open();
      await sleep(50);
      assert.deepEqual(await c.get('stock:7', async () => ({ ...row })), { stock: 0 });
    });
  });

  // ---------- Migrations ----------

  it('zero-downtime-migrations: an unnamed CREATE INDEX CONCURRENTLY that fails leaves no INVALID index behind', async () => {
    await pool.query(`CREATE TABLE r6_users (id int, email text); INSERT INTO r6_users VALUES (1, 'a@vi-du.vn'), (2, 'a@vi-du.vn')`);
    await assert.rejects(migrate.runStep(pool, { name: 'unique email', sql: 'CREATE UNIQUE INDEX CONCURRENTLY ON r6_users (email)' }), { code: '23505' });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_index WHERE indrelid = 'r6_users'::regclass AND NOT indisvalid`);
    assert.equal(rows[0].n, 0);
  });

  it('zero-downtime-migrations: a quoted identifier holding a semicolon stays in its statement, and TRUNCATE is flagged', () => {
    assert.deepEqual(
      lint.lintMigration(`ALTER TABLE "orders;archive" ADD COLUMN note text NOT NULL;`).map((f) => f.rule),
      ['add-column-not-null'],
    );
    assert.deepEqual(
      lint.lintMigration(`TRUNCATE orders;`).map((f) => `${f.severity} ${f.rule}`),
      ['warning truncate'],
    );
  });

  // ---------- Formats ----------

  it('slo-alerting: two SLOs with the same name are refused (Prometheus would refuse the whole file, every alert with it)', () => {
    const s: slo.Slo = { name: 'checkout-availability', service: 'api', objective: 0.999, errorRatio: 'sum(rate(errors[{{window}}]))' };
    assert.throws(() => slo.prometheusRules([s, { ...s, service: 'web' }]), /checkout-availability/);
  });

  it('sse-streaming: an event without data is sent with an empty data field, not a TypeError', () => {
    assert.equal(sse.formatEvent({ event: 'ping', data: undefined }), 'event: ping\ndata: \n\n');
  });
});
