// Round 5 of the latent-bug review: the code round 4 added, read again as a reviewer, and the hooks every skill
// calls (onError, onDead, onOverflow, onUsage). Each hypothesis is a test of the behaviour the skill promises.
// Namespace imports keep this file loadable against older code.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { freshDatabase, REDIS_URL, runSqlFile } from '../support/infra.ts';
import { fakeEmbedding } from '../support/vectors.ts';
import { sleep, waitFor } from '../support/wait.ts';
import * as toolGuard from '../../../skills/llm-tool-safety/references/tool-guard.ts';
import * as idem from '../../../skills/idempotency-keys/references/idempotency.ts';
import * as webhooks from '../../../skills/webhook-ingestion/references/webhooks.ts';
import * as jobs from '../../../skills/job-queue/references/jobs.ts';
import * as tenantDb from '../../../skills/multitenant-postgres/references/tenant-db.ts';
import * as lint from '../../../skills/zero-downtime-migrations/references/lint.ts';
import * as migrate from '../../../skills/zero-downtime-migrations/references/migrate.ts';
import * as redaction from '../../../skills/pii-redaction/references/redact.ts';
import * as cache from '../../../skills/cache-stampede/references/cache.ts';
import * as limiter from '../../../skills/rate-limiting/references/limiter.ts';
import * as sse from '../../../skills/sse-streaming/references/sse.ts';
import * as agentDb from '../../../skills/agent-safe-db/references/agent-db-tool.ts';
import * as gateway from '../../../skills/llm-gateway/references/gateway.ts';
import * as loops from '../../../shared/worker-loop.ts';

const TENANT = '55555555-5555-4555-8555-555555555555';
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

const broken = (what: string) => () => {
  throw new Error(`${what} is broken`);
};

describe('latent bugs, round 5: the review of round 4, and the hooks an app passes in', () => {
  before(async () => {
    dbUrl = await freshDatabase('kit_round5');
    pool = new pg.Pool({ connectionString: dbUrl, max: 8 });
    pool.on('error', () => {});
    for (const [skill, file] of [
      ['llm-tool-safety', 'tool-guard.sql'],
      ['idempotency-keys', 'idempotency.sql'],
      ['webhook-ingestion', 'inbox.sql'],
      ['job-queue', 'jobs.sql'],
      ['multitenant-postgres', 'schema.sql'],
    ]) {
      await runSqlFile(pool, skill, file);
    }
  });
  after(async () => pool?.end());

  // ---------- A tool that ran is never run again ----------

  describe('llm-tool-safety: once a write ran, a retry never runs it again', () => {
    const session = (tools: toolGuard.ToolDef[], sessionId: string) =>
      toolGuard.createToolGuard({ pool, tools }).session({ tenantId: 't1', userId: 'u1', sessionId });
    const refundTool = (result: () => unknown, runs: { n: number }): toolGuard.ToolDef => ({
      name: 'refund',
      tier: 'write',
      description: 'Refund',
      params: {},
      run: async () => {
        runs.n++;
        return result();
      },
    });

    it('a result that can not be recorded (an ORM entity pointing back at itself) does not release the call', async () => {
      const runs = { n: 0 };
      const entity: Record<string, unknown> = { refunded: 350_000 };
      entity.order = { refund: entity };
      const s = session([refundTool(() => entity, runs)], 'r5-cycle');
      assert.equal((await s.call('refund', {}, { toolCallId: 'call-1' })).status, 'error');
      const retry = await s.call('refund', {}, { toolCallId: 'call-1' });
      assert.deepEqual([retry, runs.n], [{ status: 'rejected', reason: 'this call is still running' }, 1]);
    });

    it('a result holding a BigInt (a bigint column through an ORM) is stored, and the retry replays it', async () => {
      const runs = { n: 0 };
      const s = session([refundTool(() => ({ refundId: 9007199254740993n }), runs)], 'r5-bigint');
      assert.deepEqual(await s.call('refund', {}, { toolCallId: 'call-2' }), { status: 'ok', result: { refundId: 9007199254740993n } });
      const retry = await s.call('refund', {}, { toolCallId: 'call-2' });
      assert.deepEqual([retry, runs.n], [{ status: 'ok', result: { refundId: '9007199254740993' }, replayed: true }, 1]);
    });

    it('a pattern written with the m flag still matches the whole value: "o-1\\nDROP TABLE refunds" is refused', async () => {
      const tool: toolGuard.ToolDef = {
        name: 'refund_order',
        tier: 'read',
        description: 'Refund',
        params: { orderId: { type: 'string', required: true, pattern: /^o-\d+$/m } },
        run: async () => ({}),
      };
      assert.throws(() => toolGuard.validateArgs(tool, { orderId: 'o-1\nDROP TABLE refunds' }), toolGuard.ToolArgumentError);
    });

    it('a tool-call id longer than an index entry can hold gets a result, not a database error', async () => {
      const runs = { n: 0 };
      const s = session([refundTool(() => ({ ok: true }), runs)], 'r5-long-id');
      const id = randomBytes(4000).toString('base64'); // 5,336 characters that don't compress
      assert.equal((await s.call('refund', {}, { toolCallId: id })).status, 'ok');
      assert.equal((await s.call('refund', {}, { toolCallId: id })).status, 'ok');
      assert.equal(runs.n, 1, 'the retry with the same id replays');
    });

    it('a pattern with an alternation is stated to the model anchored as a whole', () => {
      const guard = toolGuard.createToolGuard({
        pool,
        tools: [{ name: 'find', tier: 'read', description: 'Find', params: { ref: { type: 'string', pattern: /^o-\d+|c-\d+$/ } }, run: async () => ({}) }],
      });
      const [schema] = guard.schemas() as Array<{ input_schema: { properties: { ref: { pattern: string } } } }>;
      assert.equal(schema.input_schema.properties.ref.pattern, '^(?:^o-\\d+|c-\\d+$)$');
    });
  });

  // ---------- Values the app hands over are storable ----------

  it('idempotency-keys: a response holding a BigInt id is stored, so the order commits and the retry replays it', async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS r5_orders (id bigserial PRIMARY KEY)`);
    const req = { scope: 'shop:u1', key: 'k-bigint', fingerprint: idem.requestFingerprint('POST', '/orders', { sku: 'a' }) };
    const create = (tx: pg.PoolClient) =>
      tx.query(`INSERT INTO r5_orders DEFAULT VALUES RETURNING id`).then(({ rows }) => ({ status: 201, body: { orderId: BigInt(rows[0].id) } }));
    const first = await idem.runIdempotent(pool, req, create);
    const retry = await idem.runIdempotent(pool, req, create);
    assert.deepEqual([first.status, retry.status, retry.replayed, retry.body], [201, 201, true, { orderId: String(first.body && (first.body as { orderId: bigint }).orderId) }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM r5_orders`)).rows[0].n, 1);
  });

  // ---------- Strict input ----------

  describe('input is checked whole, before anything uses it', () => {
    it('webhook-ingestion: a valid signature with anything appended is refused', () => {
      const secret = 'whsec_r5';
      const body = '{"id":"evt_1"}';
      const t = 1_790_000_000;
      const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
      for (const tail of ['0', 'z', '00', ' x']) {
        assert.equal(webhooks.verifyTimestampedSignature({ secret, rawBody: body, header: `t=${t},v1=${v1}${tail}`, nowSec: t }), false, tail);
        assert.equal(webhooks.verifyHmacHex(secret, body, `${createHmac('sha256', secret).update(body).digest('hex')}${tail}`), false, tail);
      }
    });

    it('zero-downtime-migrations: a function body in $fn1$ quotes and an E-string with \\\' are one statement each', () => {
      const migration = [
        `CREATE FUNCTION reset_counters() RETURNS void AS $fn1$ UPDATE counters SET n = 0; DROP TABLE tmp_counters; $fn1$ LANGUAGE sql;`,
        `INSERT INTO notes (body) VALUES (E'it\\'s fine; DROP TABLE users');`,
      ].join('\n');
      assert.deepEqual(lint.lintMigration(migration), []);
    });

    it('job-queue: a run time that is not a date, or a priority that is not an integer, is a RangeError, not a database error', async () => {
      await assert.rejects(jobs.enqueue(pool, { kind: 'remind', runAt: new Date('31/12/2026 09:00') }), RangeError);
      await assert.rejects(jobs.enqueue(pool, { kind: 'remind', priority: 1.5 }), RangeError);
      await assert.rejects(jobs.enqueue(pool, { kind: 'remind', maxAttempts: 0 }), RangeError);
    });

    it('multitenant-postgres: a result limit taken from a query string is checked before the search runs', async () => {
      for (const limit of [-1, 1.5, 0, Number.NaN]) {
        await assert.rejects(
          tenantDb.withTenant(pool, TENANT, (c) => tenantDb.hybridSearch(c, { embedding: fakeEmbedding(1), query: 'thanh toán', limit })),
          RangeError,
          String(limit),
        );
      }
      await assert.rejects(
        tenantDb.withTenant(pool, TENANT, (c) => tenantDb.hybridSearch(c, { embedding: fakeEmbedding(1), query: 'x', candidates: 1_000_000 })),
        RangeError,
      );
    });

    it('pii-redaction: a line truncated at the limit is cut between characters, never inside an emoji', () => {
      const r = redaction.createRedactor({ maxStringLength: 10 });
      const out = r.redactString(`${'a'.repeat(9)}😀 and more`);
      assert.ok(out.isWellFormed(), JSON.stringify(out));
    });
  });

  // ---------- A hook the app passes in can not change the outcome ----------

  describe('a hook that throws, or rejects, changes nothing: the work stands and the process keeps running', () => {
    let redis: Redis;
    before(async () => {
      redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
      await redis.connect();
    });
    after(() => redis?.disconnect());

    it('webhook-ingestion: onDead throwing still leaves the event dead, and processOnce reports it', async () => {
      await webhooks.ingest(pool, { provider: 'r5', eventId: 'evt_dead', eventType: 'payment.succeeded', payload: {} });
      const worker = webhooks.createInboxWorker({ pool, handlers: { 'r5:*': broken('the handler') }, maxAttempts: 1, onDead: broken('the alert hook') });
      assert.deepEqual(await worker.processOnce(), ['dead']);
    });

    it('job-queue: an async onDead that rejects (Slack is down) is no unhandled rejection', async () => {
      await jobs.enqueue(pool, { kind: 'r5-fails', queue: 'r5', maxAttempts: 1 });
      const worker = jobs.createWorker({ pool, queue: 'r5', handlers: { 'r5-fails': broken('the handler') }, onDead: async () => Promise.reject(new Error('slack is down')) });
      const unhandled = await unhandledRejectionsDuring(async () => assert.deepEqual(await worker.processOnce(), ['dead']));
      assert.deepEqual(unhandled.map(String), []);
    });

    it('cache-stampede: onError throwing during a background refresh is no unhandled rejection, and the stale value is served', async () => {
      const c = cache.createCache({ redis, prefix: `r5:${Date.now()}`, ttlSec: 0.05, staleSec: 30, jitter: 0, onError: broken('the error hook') });
      assert.equal(await c.get('k', async () => 'first'), 'first');
      await sleep(80); // stale now
      const unhandled = await unhandledRejectionsDuring(async () => assert.equal(await c.get('k', () => Promise.reject(new Error('origin down'))), 'first'));
      assert.deepEqual(unhandled.map(String), []);
    });

    it('rate-limiting: onRedisError throwing still lets the failure mode decide', async () => {
      const dead = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, lazyConnect: true, retryStrategy: () => null });
      dead.on('error', () => {});
      const rl = limiter.createRateLimiter({ redis: dead, capacity: 5, refillPerSec: 1, failureMode: 'open', timeoutMs: 50, onRedisError: broken('the metrics hook') });
      assert.equal((await rl.check('user:1')).source, 'fail-open');
      dead.disconnect();
    });

    it('worker loops: onError throwing does not stop the loop', async () => {
      let ticks = 0;
      const ac = new AbortController();
      const running = loops.runLoops({
        tick: async () => {
          ticks++;
          throw new Error('database unreachable');
        },
        signal: ac.signal,
        idleMs: 5,
        onError: broken('the logger'),
      });
      await waitFor(() => ticks >= 3, 'three ticks', 2000).finally(() => ac.abort());
      await running;
    });

    it('sse-streaming: a subscriber that throws does not keep the event from the others, and append does not throw', () => {
      const feed = sse.createReplayBuffer<string>(10);
      const got: string[] = [];
      feed.subscribe(broken('a subscriber'));
      feed.subscribe((e) => got.push(e.data));
      feed.append('order paid');
      assert.deepEqual(got, ['order paid']);
    });

    it('sse-streaming: onOverflow throwing still drops the stalled client', async () => {
      const feed = sse.createReplayBuffer<number>(100);
      const ac = new AbortController();
      let aborted = false;
      // A stream whose socket stopped draining: every send waits forever.
      const stalled = {
        get closed() {
          return aborted;
        },
        signal: ac.signal,
        lastEventId: undefined,
        send: () => new Promise<boolean>(() => {}),
        abort: () => {
          aborted = true;
          ac.abort();
        },
      } as unknown as sse.SseStream;
      void sse.serveFeed(stalled, feed, { maxQueue: 2, onOverflow: broken('the overflow metric') });
      for (let i = 0; i < 5; i++) feed.append(i);
      assert.equal(aborted, true);
    });

    it('agent-safe-db: onError throwing for a connection the server ended does not end the process', async () => {
      const db = agentDb.createAgentDb({
        connectionString: dbUrl,
        tools: { one: { description: 'one', sql: 'SELECT 1 AS one', params: [] } },
        audit: () => {},
        onError: broken('the error hook'),
      });
      const ctx = { tenantId: TENANT, userId: 'u1' };
      await db.run('one', {}, ctx); // leaves an idle connection in the pool
      await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'agent-db' AND datname = current_database()`);
      await sleep(200);
      assert.deepEqual((await db.run('one', {}, ctx)).rows, [{ one: 1 }]);
      await db.close();
    });

    it('llm-gateway: onUsageError throwing after the answer still returns the answer', async () => {
      const gw = gateway.createGateway({
        providers: [{ name: 'p', model: 'm', complete: async () => ({ content: 'Đơn hàng đã giao', usage: { inputTokens: 1, outputTokens: 1 } }) }],
        prices: { m: { inputPer1M: 1, outputPer1M: 1 } },
        onUsage: broken('the usage sink'),
        onUsageError: broken('its reporter'),
      });
      const r = await gw.chat({ messages: [{ role: 'user', content: 'Đơn của tôi đâu?' }], cache: false }, { tenantId: 't1' });
      assert.equal(r.content, 'Đơn hàng đã giao');
    });

    it('zero-downtime-migrations: onBatch throwing does not stop the backfill halfway', async () => {
      await pool.query(`CREATE TABLE r5_backfill (id bigserial PRIMARY KEY, v int); INSERT INTO r5_backfill (v) SELECT 0 FROM generate_series(1, 5)`);
      const done = await migrate.backfill(pool, { table: 'r5_backfill', set: 'v = 1', batchSize: 2, pauseMs: 0, onBatch: broken('the progress logger') });
      assert.equal(done.updated, 5);
    });
  });
});
