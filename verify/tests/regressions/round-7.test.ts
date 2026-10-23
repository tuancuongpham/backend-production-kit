// Round 7 of the latent-bug review: state the code assumed instead of checking (a connection still running a statement
// the client gave up on, a ctid on a partitioned table, a batch that lost a row to the app), optional infrastructure
// and shutdown hooks without a deadline, personal data on the failure path, numbers Node can't schedule, loops that
// never end, and replies taken whole from a clock or a judge model.
// Each hypothesis is a test of the behaviour the skill promises. Namespace imports keep this file loadable against
// older code.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { format } from 'node:util';
import pg from 'pg';
import type { Redis } from 'ioredis';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { sleep, waitFor } from '../support/wait.ts';
import { withTimeout } from '../../../shared/with-timeout.ts';
import * as kernel from '../../../shared/pg-transaction.ts';
import * as loops from '../../../shared/worker-loop.ts';
import * as breakers from '../../../shared/circuit-breaker.ts';
import * as idempotency from '../../../skills/idempotency-keys/references/idempotency.ts';
import * as erasure from '../../../skills/data-retention-and-erasure/references/erasure.ts';
import * as migrate from '../../../skills/zero-downtime-migrations/references/migrate.ts';
import * as gateway from '../../../skills/llm-gateway/references/gateway.ts';
import * as pgStores from '../../../skills/llm-gateway/references/pg-stores.ts';
import * as server from '../../../skills/service-hardening/references/server.ts';
import * as tracing from '../../../skills/llm-observability/references/llm-tracing.ts';
import * as redaction from '../../../skills/pii-redaction/references/redact.ts';
import * as jobs from '../../../skills/job-queue/references/jobs.ts';
import * as webhooks from '../../../skills/webhook-ingestion/references/webhooks.ts';
import * as sse from '../../../skills/sse-streaming/references/sse.ts';
import * as cache from '../../../skills/cache-stampede/references/cache.ts';
import * as limiter from '../../../skills/rate-limiting/references/limiter.ts';
import * as outbox from '../../../skills/outbox-pattern/references/outbox.ts';
import * as agentDb from '../../../skills/agent-safe-db/references/agent-db-tool.ts';
import * as judge from '../../../skills/rag-evals/references/judge.ts';

const TENANT = '77777777-7777-4777-8777-777777777777';
/** One past the longest timer Node can schedule (2^31 − 1 ms, about 24.8 days). Node runs a longer one after 1 ms. */
const PAST_TIMER_MAX = 2 ** 31;
let dbUrl: string;
let pool: pg.Pool;

/** A hypothesis whose bug is a hang fails after `ms` instead of stalling the suite. */
const within = <T>(ms: number, p: Promise<T>) => withTimeout(p, ms, () => new Error(`still waiting after ${ms} ms`));

/**
 * A pool as resilience-testing recommends one: with a client-side query timeout (here 300 ms). One connection, so the
 * next caller gets the connection the previous one used.
 */
function poolWithQueryTimeout() {
  const p = new pg.Pool({ connectionString: dbUrl, max: 1, query_timeout: 300 });
  p.on('error', () => {});
  return p;
}

/** Until the server has finished the statements the client gave up on: they go on running there. */
const slowStatementsDone = () =>
  waitFor(
    async () =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'active' AND query LIKE '%pg_sleep%' AND pid <> pg_backend_pid()`,
        )
      ).rows[0].n === 0,
    'the statements the client gave up on to finish',
  );

const ids = async (table: string) => (await pool.query(`SELECT coalesce(array_agg(id ORDER BY id), '{}') AS ids FROM ${table}`)).rows[0].ids;

describe('latent bugs, round 7: unknown state, deadlines, the failure path, and numbers taken on trust', () => {
  before(async () => {
    dbUrl = await freshDatabase('kit_round7');
    pool = new pg.Pool({ connectionString: dbUrl, max: 8 });
    pool.on('error', () => {});
    for (const [skill, file] of [
      ['idempotency-keys', 'idempotency.sql'],
      ['job-queue', 'jobs.sql'],
      ['webhook-ingestion', 'inbox.sql'],
      ['llm-gateway', 'semantic-cache.sql'],
    ]) {
      await runSqlFile(pool, skill, file);
    }
  });
  after(async () => pool?.end());

  // ---------- A connection back in the pool while its statement still runs ----------

  describe('a statement the client gave up on (query_timeout) still runs on the server, in its transaction', () => {
    it('kernel: its transaction is rolled back, not committed by the next transaction on that connection', async () => {
      await pool.query('CREATE TABLE r7_probe (id int)');
      const p = poolWithQueryTimeout();
      try {
        await assert.rejects(
          kernel.withTransaction(p, async (c) => {
            await c.query('INSERT INTO r7_probe VALUES (1)');
            await c.query('SELECT pg_sleep(1)'); // a slow trigger, a lock wait, a slow network: the client gives up
          }),
          /Query read timeout/,
        );
        await slowStatementsDone();
        await kernel.withTransaction(p, (c) => c.query('INSERT INTO r7_probe VALUES (2)'));
        assert.deepEqual(await ids('r7_probe'), [2], 'the first caller was told its transaction failed: its row must not exist');
      } finally {
        await p.end();
      }
    });

    it('kernel: the next caller gets a connection of its own, instead of timing out behind that statement', async () => {
      const p = poolWithQueryTimeout();
      try {
        await assert.rejects(kernel.withClient(p, (c) => c.query('SELECT pg_sleep(1)')), /Query read timeout/);
        assert.equal((await p.query('SELECT 1 AS ok')).rows[0].ok, 1);
      } finally {
        await slowStatementsDone();
        await p.end();
      }
    });

    it('kernel: a BEGIN that outlived the timeout leaves no transaction open on a pooled connection', async () => {
      await pool.query('CREATE TABLE r7_begin (id int)');
      const p = poolWithQueryTimeout();
      try {
        // `begin` is how the skills set a transaction up in one round trip: a tenant, a timeout, READ ONLY.
        await assert.rejects(
          kernel.withTransaction(p, (c) => c.query('SELECT 1'), { begin: 'BEGIN; INSERT INTO r7_begin VALUES (1); SELECT pg_sleep(1)' }),
          /Query read timeout/,
        );
        await slowStatementsDone();
        await kernel.withTransaction(p, (c) => c.query('INSERT INTO r7_begin VALUES (2)'));
        assert.deepEqual(await ids('r7_begin'), [2]);
      } finally {
        await p.end();
      }
    });

    it("idempotency-keys: an order whose handler timed out isn't committed later by another request, so the client's retry makes one order, not two", async () => {
      await pool.query('CREATE TABLE r7_orders (id bigserial PRIMARY KEY, item text NOT NULL)');
      const p = poolWithQueryTimeout();
      const keys = new idempotency.IdempotencyKeys({ pool: p, staleAfterSec: 0.2 });
      const req = { scope: `${TENANT}:user-1`, key: 'b6f1c2d4-order-retry', fingerprint: idempotency.requestFingerprint('POST', '/orders', { item: 'sách' }) };
      const placeOrder = (slow: boolean) => async (c: pg.PoolClient) => {
        await c.query(`INSERT INTO r7_orders (item) VALUES ('sách')`);
        if (slow) await c.query('SELECT pg_sleep(1)');
        return { status: 201, body: { ok: true } };
      };
      try {
        await assert.rejects(keys.run(req, placeOrder(true)), /Query read timeout/);
        await slowStatementsDone();
        await kernel.withTransaction(p, (c) => c.query('SELECT 1')); // any other request of the app, on the same pool
        await keys.run(req, placeOrder(false)); // the client retries the same key
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM r7_orders')).rows[0].n, 1);
      } finally {
        await p.end();
      }
    });
  });

  // ---------- Rows chosen by something that isn't what the code assumed ----------

  it('data-retention: on a table partitioned by time, retention deletes the expired rows only, not fresh rows with the same ctid in another partition', async () => {
    await pool.query(`
      CREATE TABLE r7_events (id int, user_id text, ip text, created_at timestamptz NOT NULL) PARTITION BY RANGE (created_at);
      CREATE TABLE r7_events_2020 PARTITION OF r7_events FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');
      CREATE TABLE r7_events_now PARTITION OF r7_events FOR VALUES FROM ('2021-01-01') TO ('2100-01-01');
      INSERT INTO r7_events SELECT g, 'u' || g, '203.113.0.' || g, '2020-06-01' FROM generate_series(1, 5) g;
      INSERT INTO r7_events SELECT 100 + g, 'u' || g, '203.113.1.' || g, now() FROM generate_series(1, 5) g;`);
    const lifecycle = erasure.createDataLifecycle({
      pool,
      pepper: 'r7-pepper',
      inventory: [{ table: 'r7_events', subjectColumn: 'user_id', personal: ['ip'], onErase: 'delete', retentionDays: 30, timeColumn: 'created_at' }],
    });
    assert.deepEqual(await lifecycle.runRetention(), { r7_events: 5 });
    assert.deepEqual(await ids('r7_events'), [101, 102, 103, 104, 105]);
  });

  it('zero-downtime-migrations: a backfill runs to the end on a table the app deletes from: a batch that lost a row is not the last batch', async () => {
    await pool.query(`CREATE TABLE r7_accounts (id bigint PRIMARY KEY, plan text, plan_v2 text);
      INSERT INTO r7_accounts SELECT g, 'pro', NULL FROM generate_series(1, 25) g`);
    const app = await pool.connect();
    try {
      await app.query('BEGIN');
      await app.query('SELECT 1 FROM r7_accounts WHERE id = 5 FOR UPDATE'); // a user closing their account
      const run = migrate.backfill(pool, { table: 'r7_accounts', set: 'plan_v2 = upper(plan)', where: 'plan_v2 IS NULL', batchSize: 10, pauseMs: 0 });
      await waitFor(
        async () =>
          (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%plan_v2 = upper(plan)%'`)).rows[0].n > 0,
        "the first batch to wait for the app's row",
      );
      await app.query('DELETE FROM r7_accounts WHERE id = 5');
      await app.query('COMMIT');
      const result = await run;
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM r7_accounts WHERE plan_v2 IS NULL')).rows[0].n, 0);
      assert.deepEqual([result.updated, result.lastId], [24, '25']);
    } finally {
      app.release();
    }
  });

  // ---------- Every wait has a deadline: optional infrastructure, shutdown hooks ----------

  describe('optional infrastructure that never answers', () => {
    const answering: gateway.Provider = {
      name: 'anthropic',
      model: 'claude-x',
      complete: async () => ({ content: 'Vào Đơn hàng, chọn Hủy đơn.', usage: { inputTokens: 18, outputTokens: 9 } }),
    };
    const prices = { 'claude-x': { inputPer1M: 3, outputPer1M: 15 } };

    it("llm-gateway: an embedding API that never answers doesn't hold the answer (semantic cache in shadow mode, the default)", async () => {
      const reported: string[] = [];
      const gw = gateway.createGateway({
        providers: [answering],
        prices,
        cache: gateway.memoryCache(),
        embed: () => new Promise<number[]>(() => {}),
        cacheTimeoutMs: 100,
        onError: (_err, stage) => void reported.push(stage),
      });
      const res = await within(2_000, gw.chat({ messages: [{ role: 'user', content: 'Làm sao để hủy đơn hàng?' }] }, { tenantId: TENANT }));
      assert.equal(res.content, 'Vào Đơn hàng, chọn Hủy đơn.');
      assert.deepEqual([...new Set(reported)], ['embed']);
    });

    it("llm-gateway: a cache store that never answers doesn't hold the request: the model answers it", async () => {
      const reported: string[] = [];
      const hung = () => new Promise<never>(() => {});
      const gw = gateway.createGateway({
        providers: [answering],
        prices,
        cache: { getExact: hung, setExact: hung, findSimilar: hung, saveSimilar: hung },
        cacheTimeoutMs: 100,
        onError: (_err, stage) => void reported.push(stage),
      });
      const res = await within(2_000, gw.chat({ messages: [{ role: 'user', content: 'Phí vận chuyển là bao nhiêu?' }] }, { tenantId: TENANT }));
      assert.equal(res.cache, 'miss');
      assert.deepEqual([...new Set(reported)].sort(), ['cache-read', 'cache-write']);
    });

    it("service-hardening: a shutdown hook that never settles doesn't keep the process from exiting, and the hooks after it still run", async () => {
      const done: string[] = [];
      const app = server.createHardenedServer({
        handler: (_req, res) => void res.end('ok'),
        drainDelayMs: 0,
        shutdownHookTimeoutMs: 100,
        onShutdown: [
          () => new Promise(() => {}), // pool.end() waiting for a client that was never released
          async () => void done.push('traces flushed'),
        ],
      });
      await app.listen(0, '127.0.0.1');
      assert.deepEqual(await within(2_000, app.shutdown()), { forced: false });
      assert.deepEqual(done, ['traces flushed']);
    });
  });

  // ---------- Personal data on the failure path ----------

  describe('what leaves the process when something fails', () => {
    it('llm-observability: the exception of a failed call or retrieval reaches the trace redacted, like the prompt', async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      const tracer = provider.getTracer('round-7');
      const redact = redaction.createRedactor().redactString;
      try {
        await assert.rejects(
          tracing.withLlmSpan(
            tracer,
            { provider: 'anthropic', model: 'claude-x', messages: [{ role: 'user', content: 'Đổi email của tôi thành lan.nguyen@shop.vn' }], tenantId: TENANT },
            async () => {
              throw new Error('duplicate key value violates unique constraint: Key (email)=(lan.nguyen@shop.vn) already exists');
            },
            { redact },
          ),
        );
        await assert.rejects(
          tracing.withRetrievalSpan(tracer, 'đơn hàng của lan.nguyen@shop.vn', async () => {
            throw new Error('search failed for "đơn hàng của lan.nguyen@shop.vn"');
          }, { redact }),
        );
        const exported = JSON.stringify(exporter.getFinishedSpans().map((s) => ({ attributes: s.attributes, events: s.events, status: s.status })));
        assert.ok(!exported.includes('lan.nguyen@shop.vn'), exported);
        assert.match(exported, /already exists/);
      } finally {
        await provider.shutdown();
      }
    });

    it('pii-redaction: an AggregateError (what a scheduler tick throws when schedules fail) is logged with the errors it holds, redacted', async () => {
      const scheduler = jobs.createScheduler({
        pool,
        schedules: [
          {
            name: 'r7-digest',
            kind: 'digest',
            next: () => {
              throw new Error('cron "0 7 * * *" of lan.nguyen@shop.vn: parser failed');
            },
          },
          { name: 'r7-report', kind: 'report', next: () => new Date(Number.NaN) },
        ],
      });
      const err = await scheduler.tick().then(() => null, (e: unknown) => e);
      assert.ok(err instanceof AggregateError);
      const logged = JSON.stringify(redaction.createRedactor().redactValue(err));
      assert.match(logged, /parser failed/);
      assert.match(logged, /r7-report.*Invalid Date/);
      assert.ok(!logged.includes('lan.nguyen@shop.vn'), logged);
    });

    it("pii-redaction: pino's interpolation arguments are redacted too: logger.info('order %j', order) logged the customer's email", () => {
      const { hooks } = redaction.pinoRedactionOptions(redaction.createRedactor());
      // pino formats the message from what the hook passes on, after it; formatters.log never sees that message.
      const logLine = (...args: unknown[]) => {
        let passedOn: unknown[] = [];
        hooks.logMethod.call(null, args, (...a: unknown[]) => void (passedOn = a));
        return format(...(passedOn as [string, ...unknown[]]));
      };
      assert.equal(logLine('order %j', { id: 7, email: 'lan.nguyen@shop.vn' }), 'order {"id":7,"email":"[EMAIL]"}');
      assert.equal(logLine('payment failed: %s', new Error('card of lan.nguyen@shop.vn declined')), 'payment failed: Error: card of [EMAIL] declined');
      assert.equal(logLine('sms to %s', '0901 234 567'), 'sms to [PHONE]');
    });
  });

  // ---------- Numbers Node can't schedule, loops that never end ----------

  describe('a duration Node can\'t schedule (above 2^31 − 1 ms, about 24.8 days) is refused, instead of firing after 1 ms', () => {
    it('sse-streaming: a heartbeat of 30 days pinged every millisecond', async () => {
      const writes: string[] = [];
      const res = { writeHead: () => res, write: (s: string) => (writes.push(s), true), end: () => {}, on: () => res, writableEnded: false, writableLength: 0 };
      const req = { headers: {}, on: () => req };
      let stream: sse.SseStream | undefined;
      try {
        assert.throws(() => (stream = sse.openSse(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, { heartbeatMs: PAST_TIMER_MAX })), RangeError);
      } finally {
        await sleep(50);
        stream?.close();
      }
      assert.equal(writes.filter((w) => w === ': ping\n\n').length, 0, 'pings in 50 ms');
    });

    it('worker loops: an idle pause of 30 days polled the database every millisecond', async () => {
      const ac = new AbortController();
      let ticks = 0;
      const outcome = loops.runLoops({ tick: async () => (ticks++, false), signal: ac.signal, idleMs: PAST_TIMER_MAX }).then(
        () => `ran ${ticks} ticks in 50 ms`,
        (e: unknown) => e,
      );
      await sleep(50);
      ac.abort();
      const result = await outcome;
      assert.ok(result instanceof RangeError, String(result));
    });

    it('every other timer taken from the options is refused at construction', async () => {
      const fakeRedis = {} as Redis;
      const fakePool = {} as pg.Pool;
      const refused = (label: string, make: () => unknown) => assert.throws(make, RangeError, label);
      refused('job worker timeoutMs: every job "timed out" at once', () => jobs.createWorker({ pool: fakePool, handlers: {}, timeoutMs: PAST_TIMER_MAX }));
      refused('server drainDelayMs: no drain at all', () => server.createHardenedServer({ handler: () => {}, drainDelayMs: PAST_TIMER_MAX }));
      refused('server shutdownGraceMs: in-flight requests cut at once', () => server.createHardenedServer({ handler: () => {}, shutdownGraceMs: PAST_TIMER_MAX }));
      refused('server keepAliveTimeoutMs: idle keep-alive sockets closed after 1 ms (502s at the load balancer)', () =>
        server.createHardenedServer({ handler: () => {}, keepAliveTimeoutMs: PAST_TIMER_MAX }),
      );
      refused('cache timeoutMs: every Redis call timed out', () => cache.createCache({ redis: fakeRedis, prefix: 'r7', ttlSec: 60, timeoutMs: PAST_TIMER_MAX }));
      refused('limiter timeoutMs: every check ran in the failure mode', () =>
        limiter.createRateLimiter({ redis: fakeRedis, capacity: 10, refillPerSec: 1, failureMode: 'open', timeoutMs: PAST_TIMER_MAX }),
      );
      refused('outbox publishTimeoutMs: every publish failed, the outbox stopped', () => outbox.createRelay({ pool: fakePool, publish: async () => {}, publishTimeoutMs: PAST_TIMER_MAX }));
      refused('erasure storeTimeoutMs: no store was ever erased', () =>
        erasure.createDataLifecycle({ pool: fakePool, inventory: [], pepper: 'p', storeTimeoutMs: PAST_TIMER_MAX, leaseSec: 1e8 }),
      );
      refused('agent db statementTimeoutMs: every tool call timed out on the client', () =>
        agentDb.createAgentDb({ connectionString: dbUrl, tools: {}, audit: () => {}, statementTimeoutMs: PAST_TIMER_MAX }),
      );
      refused('agent db connectTimeoutMs', () => agentDb.createAgentDb({ connectionString: dbUrl, tools: {}, audit: () => {}, connectTimeoutMs: PAST_TIMER_MAX }));
      refused('gateway cacheTimeoutMs', () =>
        gateway.createGateway({ providers: [{ name: 'p', model: 'm', complete: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }) }], prices: {}, cacheTimeoutMs: PAST_TIMER_MAX }),
      );
      refused('server shutdownHookTimeoutMs', () => server.createHardenedServer({ handler: () => {}, shutdownHookTimeoutMs: PAST_TIMER_MAX }));
      await assert.rejects(migrate.backfill(fakePool, { table: 'accounts', set: 'plan_v2 = plan', pauseMs: PAST_TIMER_MAX }), RangeError, 'backfill pauseMs: no pause at all');
    });

    it('a prune with batchSize 0 is refused, instead of deleting nothing in a loop that never ends', async () => {
      await pool.query('CREATE TABLE r7_visits (user_id text, ip text, seen_at timestamptz)');
      const refused = (label: string, run: () => Promise<unknown>) => assert.rejects(within(1_000, run()), RangeError, label);
      await refused('pruneInbox', () => webhooks.pruneInbox(pool, { batchSize: 0 }));
      await refused('pruneJobs', () => jobs.pruneJobs(pool, { batchSize: 0 }));
      await refused('idempotency prune', () => new idempotency.IdempotencyKeys({ pool }).prune(0));
      await refused('pruneLlmCache', () => pgStores.pruneLlmCache(pool, 0));
      const lifecycle = erasure.createDataLifecycle({
        pool,
        pepper: 'r7-pepper',
        inventory: [{ table: 'r7_visits', subjectColumn: 'user_id', personal: ['ip'], onErase: 'delete', retentionDays: 90, timeColumn: 'seen_at' }],
      });
      await refused('runRetention', () => lifecycle.runRetention(0));
    });
  });

  // ---------- Replies taken whole: a clock, a judge ----------

  describe('a clock stepped back (NTP correcting a drifted host, a VM resumed)', () => {
    it("rate-limiting: the local fallback bucket isn't emptied for the hour the clock jumped back (the Redis script clamps; the local bucket didn't)", async () => {
      let now = Date.UTC(2026, 9, 23, 9, 0, 0);
      const down = () => Promise.reject(new Error('connect ECONNREFUSED'));
      const redis = { evalsha: down, eval: down } as unknown as Redis;
      const rl = limiter.createRateLimiter({ redis, capacity: 10, refillPerSec: 1, failureMode: 'local', now: () => now, onRedisError: () => {} });
      assert.equal((await rl.check('tenant:7:route:/v1/chat')).allowed, true);
      now -= 3_600_000;
      const r = await rl.check('tenant:7:route:/v1/chat');
      assert.deepEqual([r.source, r.allowed], ['local', true], `retry after ${r.retryAfterMs} ms`);
    });

    it("circuit breaker: the circuit isn't kept open for the length of the step: one probe after a cooldown", () => {
      let now = 1_000_000_000;
      const b = new breakers.CircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: () => now });
      b.failure();
      now -= 3_600_000;
      assert.equal(b.tryAcquire(), false, 'still open: the dependency failed a moment ago');
      now += 1_000;
      assert.equal(b.tryAcquire(), true, 'one probe after the cooldown, not an hour later');
    });
  });

  it("rag-evals: a judge's reply is checked: 'Pass' is not a fail, an unknown verdict is an error, and keys it adds can't overwrite the case", async () => {
    const cases: judge.JudgeCase[] = [
      { id: 'c1', question: 'Phí ship bao nhiêu?', context: ['Phí ship 30.000đ toàn quốc'], answer: 'Phí ship là 30.000đ', human: 'pass' },
      { id: 'c2', question: 'Đổi trả mấy ngày?', context: ['Đổi trả trong 7 ngày'], answer: 'Bạn được đổi trả trong 30 ngày', human: 'fail' },
    ];
    // The judge model's JSON, parsed as is: a capitalized verdict, and a "human" key the answer under test talked it into.
    const replies: Record<string, unknown> = { c1: { verdict: 'Pass', reason: 'supported' }, c2: { verdict: 'pass', reason: 'looks fine', human: 'pass' } };
    const { results, passRate } = await judge.runJudge(cases, async (c) => replies[c.id] as never);
    assert.equal(passRate, 1);
    assert.deepEqual(results.map((r) => r.human), ['pass', 'fail']);
    assert.equal(judge.judgeAgreement(results).falsePasses, 1, 'the judge passed what a human failed: the number that matters');
    await assert.rejects(judge.runJudge([cases[0]], async () => ({ verdict: 'mostly', reason: '' }) as never), /c1.*verdict/);
  });

  it('agent-safe-db: a tool whose SQL ends with a comment runs, instead of failing every call; a trailing semicolon is refused at startup', async () => {
    const db = agentDb.createAgentDb({
      connectionString: dbUrl,
      audit: () => {},
      tools: { latest: { description: 'The newest row', sql: 'SELECT 1 AS n -- newest first', params: [] } },
    });
    try {
      assert.deepEqual((await db.run('latest', {}, { tenantId: TENANT, userId: 'u1' })).rows, [{ n: 1 }]);
    } finally {
      await db.close();
    }
    let second: agentDb.AgentDb | undefined;
    try {
      assert.throws(
        () => (second = agentDb.createAgentDb({ connectionString: dbUrl, audit: () => {}, tools: { t: { description: 'x', sql: 'SELECT 1;', params: [] } } })),
        /semicolon/,
      );
    } finally {
      await second?.close();
    }
  });
});
