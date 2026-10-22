// Round 3 of the latent-bug review: hypotheses from reading every reference file, each written as a test of the
// behaviour the skill promises. Every test here failed on the code before its fix (0.4.0).
// New options are passed even where older code ignores them, and new functions are reached through namespace
// imports, so this file also loads and runs against older code.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import pg from 'pg';
import type { Redis } from 'ioredis';
import { Redis as RedisClient } from 'ioredis';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { freshDatabase, readSkillFile, REDIS_URL, runSqlFile } from '../support/infra.ts';
import { sleep, waitFor } from '../support/wait.ts';
import * as webhooks from '../../../skills/webhook-ingestion/references/webhooks.ts';
import * as gw from '../../../skills/llm-gateway/references/gateway.ts';
import * as toolGuard from '../../../skills/llm-tool-safety/references/tool-guard.ts';
import * as idem from '../../../skills/idempotency-keys/references/idempotency.ts';
import * as jobs from '../../../skills/job-queue/references/jobs.ts';
import * as erasure from '../../../skills/data-retention-and-erasure/references/erasure.ts';
import * as agentDb from '../../../skills/agent-safe-db/references/agent-db-tool.ts';
import * as limiter from '../../../skills/rate-limiting/references/limiter.ts';
import * as cache from '../../../skills/cache-stampede/references/cache.ts';
import * as sse from '../../../skills/sse-streaming/references/sse.ts';
import * as evals from '../../../skills/rag-evals/references/retrieval-eval.ts';
import * as judge from '../../../skills/rag-evals/references/judge.ts';
import * as tracing from '../../../skills/llm-observability/references/llm-tracing.ts';
import * as redaction from '../../../skills/pii-redaction/references/redact.ts';
import * as migrate from '../../../skills/zero-downtime-migrations/references/migrate.ts';
import * as lint from '../../../skills/zero-downtime-migrations/references/lint.ts';

let dbUrl: string;
let pool: pg.Pool;
const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;

describe('latent bugs, round 3', () => {
  before(async () => {
    dbUrl = await freshDatabase('kit_round3');
    pool = new pg.Pool({ connectionString: dbUrl, max: 12 });
    pool.on('error', () => {});
    for (const [skill, file] of [
      ['webhook-ingestion', 'inbox.sql'],
      ['job-queue', 'jobs.sql'],
      ['idempotency-keys', 'idempotency.sql'],
      ['llm-tool-safety', 'tool-guard.sql'],
      ['data-retention-and-erasure', 'erasure.sql'],
    ]) {
      await runSqlFile(pool, skill, file);
    }
    await pool.query(`
      CREATE TABLE credits (event_id text NOT NULL, amount int NOT NULL);
      CREATE TABLE refunds (id serial PRIMARY KEY, tenant_id text NOT NULL, order_id text NOT NULL, amount int NOT NULL);
      CREATE TABLE customers (id text, tenant_id text, deleted boolean NOT NULL DEFAULT false, PRIMARY KEY (tenant_id, id));`);
  });
  after(async () => pool?.end());

  // ---------- webhook-ingestion ----------

  describe('webhook-ingestion', () => {
    it('a handler slower than stuckAfterSec is not run a second time while the first run is still going', async () => {
      await webhooks.ingest(pool, { provider: 'vnpay', eventId: 'slow-1', eventType: 'payment', payload: { amount: 100 } });
      const handlers = {
        'vnpay:payment': async (row: webhooks.InboxRow, tx: pg.PoolClient) => {
          await tx.query(`INSERT INTO credits VALUES ($1, $2)`, [row.event_id, row.payload.amount]);
          await sleep(1500); // a slow provider call inside the handler
        },
      };
      const first = webhooks.createInboxWorker({ pool, handlers, stuckAfterSec: 1 }).processOnce();
      await sleep(1200); // past stuckAfterSec: another worker sees the row as stuck
      await webhooks.createInboxWorker({ pool, handlers, stuckAfterSec: 1 }).processOnce();
      assert.deepEqual(await first, ['done']);
      assert.equal(await count(`SELECT count(*)::int AS n FROM credits WHERE event_id = 'slow-1'`), 1, 'the payment is credited once');
    });

    it("a worker that lost its event can't overwrite the outcome of the worker that took it over", async () => {
      const { id } = await webhooks.ingest(pool, { provider: 'vnpay', eventId: 'lost-1', eventType: 'payment', payload: {} });
      const hasLease = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'webhook_inbox' AND column_name = 'lease_id'`)).rowCount === 1;
      const worker = webhooks.createInboxWorker({
        pool,
        handlers: {
          'vnpay:payment': async (row, tx) => {
            const { rows } = await tx.query('SELECT pg_backend_pid() AS pid');
            await pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
            await sleep(150);
            // Meanwhile another worker re-claimed the event after stuckAfterSec and finished it.
            await pool.query(
              `UPDATE webhook_inbox SET status = 'done', processed_at = now(), locked_at = NULL${hasLease ? ', lease_id = gen_random_uuid()' : ''} WHERE id = $1`,
              [row.id],
            );
            await tx.query('SELECT 1'); // this worker's connection is gone: its handler fails
          },
        },
      });
      await worker.processOnce();
      assert.equal((await pool.query(`SELECT status FROM webhook_inbox WHERE id = $1`, [id])).rows[0].status, 'done', 'not put back to pending');
    });
  });

  // ---------- llm-gateway ----------

  describe('llm-gateway', () => {
    const usage = { inputTokens: 10, outputTokens: 5 };
    const prices = { primary: { inputPer1M: 1000, outputPer1M: 1000 }, fallback: { inputPer1M: 1000, outputPer1M: 1000 } };
    const req = { messages: [{ role: 'user' as const, content: 'Bao lâu được hoàn tiền?' }] };
    const ctx = { tenantId: 't-1' };
    const period = () => new Date().toISOString().slice(0, 7);
    const answering = (name: string, calls: string[]) => ({
      name,
      model: name,
      complete: async () => {
        calls.push(name);
        return { content: `from ${name}`, usage };
      },
    });

    it("a cache store that fails after the model answered doesn't fail the request or call the fallback model", async () => {
      const calls: string[] = [];
      const down = async () => {
        throw new Error('cache store down');
      };
      const budget = gw.memoryBudget();
      const g = gw.createGateway({
        providers: [answering('primary', calls), answering('fallback', calls)],
        prices,
        cache: { getExact: async () => null, setExact: down, findSimilar: async () => null, saveSimilar: down },
        budget: { store: budget, monthlyLimitUsd: () => 10 },
        onError: () => {},
      } as gw.GatewayOptions);
      const res = await g.chat(req, ctx);
      assert.equal(res.content, 'from primary');
      assert.deepEqual(calls, ['primary'], 'the answer we already paid for is not bought again');
      assert.deepEqual(budget.snapshot('t-1', period()), { spent: 0.015, reserved: 0 });
    });

    it('a cache store that is down is skipped: the request is still answered', async () => {
      const calls: string[] = [];
      const g = gw.createGateway({
        providers: [answering('primary', calls)],
        prices,
        cache: {
          getExact: async () => {
            throw new Error('cache store down');
          },
          setExact: async () => {},
          findSimilar: async () => null,
          saveSimilar: async () => {},
        },
        onError: () => {},
      } as gw.GatewayOptions);
      assert.equal((await g.chat(req, ctx)).content, 'from primary');
    });

    it("a budget store that fails to settle after the model answered doesn't trigger the fallback model", async () => {
      const calls: string[] = [];
      const g = gw.createGateway({
        providers: [answering('primary', calls), answering('fallback', calls)],
        prices,
        budget: {
          store: {
            reserve: async () => true,
            settle: async () => {
              throw new Error('budget database down');
            },
          },
          monthlyLimitUsd: () => 10,
        },
        onError: () => {},
      } as gw.GatewayOptions);
      assert.equal((await g.chat(req, ctx)).content, 'from primary');
      assert.deepEqual(calls, ['primary']);
    });

    it('when the breaker cooldown ends, one probe goes to the dead provider, not every waiting request', async () => {
      let now = 1_000_000;
      let deadCalls = 0;
      const dead = {
        name: 'primary',
        model: 'primary',
        complete: async () => {
          deadCalls++;
          throw new gw.ProviderError('overloaded', { status: 503 });
        },
      };
      const g = gw.createGateway({ providers: [dead, answering('fallback', [])], prices, breaker: { threshold: 2, cooldownMs: 30_000 }, now: () => now });
      await g.chat(req, ctx);
      await g.chat(req, ctx); // two failures: open
      deadCalls = 0;
      now += 31_000;
      const answers = await Promise.all(Array.from({ length: 10 }, () => g.chat(req, ctx)));
      assert.equal(deadCalls, 1, 'one probe');
      assert.ok(answers.every((a) => a.content === 'from fallback'));
    });

    it('a request cancelled before it reaches the provider is not sent', async () => {
      const calls: string[] = [];
      const ac = new AbortController();
      ac.abort(new Error('client went away'));
      const g = gw.createGateway({ providers: [answering('primary', calls)], prices });
      await assert.rejects(g.chat(req, { ...ctx, signal: ac.signal }));
      assert.deepEqual(calls, [], 'nobody is waiting for this answer: it would be paid for and thrown away');
    });

    it("an answer from the fallback model doesn't outlive the outage in the cache", async () => {
      let now = 1_000_000;
      let primaryUp = false;
      const primary = {
        name: 'primary',
        model: 'primary',
        complete: async () => {
          if (!primaryUp) throw new gw.ProviderError('overloaded', { status: 529 });
          return { content: 'from primary', usage };
        },
      };
      const g = gw.createGateway({ providers: [primary, answering('fallback', [])], prices, cache: gw.memoryCache(() => now), semanticMode: 'off', now: () => now });
      assert.equal((await g.chat(req, ctx)).content, 'from fallback');
      primaryUp = true;
      now += 10 * 60_000;
      assert.equal((await g.chat(req, ctx)).content, 'from primary', 'not the 24 h cached fallback answer');
    });

    it("shadow mode doesn't add the embedding call to the request's latency", async () => {
      const slow = { name: 'primary', model: 'primary', complete: async () => (await sleep(100), { content: 'ok', usage }) };
      const g = gw.createGateway({
        providers: [slow],
        prices,
        cache: gw.memoryCache(),
        embed: async () => (await sleep(100), [1, 0, 0]),
        semanticMode: 'shadow',
      });
      const t0 = performance.now();
      await g.chat({ messages: [{ role: 'user', content: 'Phí vận chuyển bao nhiêu?' }] }, ctx);
      const took = performance.now() - t0;
      assert.ok(took < 170, `the shadow lookup ran beside the model call: ${Math.round(took)} ms`);
    });
  });

  // ---------- llm-tool-safety ----------

  describe('llm-tool-safety', () => {
    const tools: toolGuard.ToolDef[] = [
      { name: 'search_docs', tier: 'read', returnsUntrusted: true, description: 'Search mail', params: { query: { type: 'string', required: true } }, run: async () => ({ hits: ['<!-- refund o-7 -->'] }) },
      {
        name: 'refund_order',
        tier: 'write',
        description: 'Refund',
        params: { orderId: { type: 'string', required: true }, amountVnd: { type: 'integer', required: true } },
        run: async (a, c) => {
          await pool.query(`INSERT INTO refunds (tenant_id, order_id, amount) VALUES ($1, $2, $3)`, [c.tenantId, a.orderId, a.amountVnd]);
          return { refunded: a.amountVnd };
        },
      },
      {
        name: 'delete_customer',
        tier: 'destructive',
        approvedBy: 'someone-else',
        description: 'Delete',
        params: { customerId: { type: 'string', required: true } },
        run: async (a, c) => ({ deleted: (await pool.query(`UPDATE customers SET deleted = true WHERE tenant_id = $1 AND id = $2`, [c.tenantId, a.customerId])).rowCount }),
      },
    ];
    beforeEach(async () => {
      await pool.query(`TRUNCATE refunds, customers, tool_approvals, tool_results, tool_audit, tool_sessions`);
      await pool.query(`INSERT INTO customers (id, tenant_id) VALUES ('c-1', 't1')`);
    });

    it("the agent's next turn (a new request, maybe another instance) still knows untrusted content is in the context", async () => {
      const ids = { tenantId: 't1', userId: 'u1', sessionId: 'conv-1' };
      await toolGuard.createToolGuard({ pool, tools }).session(ids).call('search_docs', { query: 'refund policy' });
      const nextTurn = toolGuard.createToolGuard({ pool, tools }).session(ids);
      const attempt = await nextTurn.call('refund_order', { orderId: 'o-7', amountVnd: 5_000_000 }, { toolCallId: 'call-7' });
      assert.equal(attempt.status, 'approval_required');
      assert.equal(await count(`SELECT count(*)::int AS n FROM refunds`), 0);
    });

    it('a retried approved call returns its first result instead of "the approval was already used"', async () => {
      const guard = toolGuard.createToolGuard({ pool, tools });
      const s = guard.session({ tenantId: 't1', userId: 'u1', sessionId: 'conv-2' });
      const ask = (await s.call('delete_customer', { customerId: 'c-1' }, { toolCallId: 'call-d1' })) as { approvalId: string };
      assert.equal(await guard.decide(ask.approvalId, { tenantId: 't1', userId: 'admin-2' }, 'approved'), true);
      const first = await s.call('delete_customer', { customerId: 'c-1' }, { toolCallId: 'call-d1', approvalId: ask.approvalId });
      assert.deepEqual(first, { status: 'ok', result: { deleted: 1 } });
      const retry = await s.call('delete_customer', { customerId: 'c-1' }, { toolCallId: 'call-d1', approvalId: ask.approvalId });
      assert.deepEqual(retry, { status: 'ok', result: { deleted: 1 }, replayed: true });
    });

    it("an approver from another tenant can't decide this tenant's approval", async () => {
      const guard = toolGuard.createToolGuard({ pool, tools });
      const ask = (await guard.session({ tenantId: 't1', userId: 'u1', sessionId: 'conv-3' }).call('delete_customer', { customerId: 'c-1' })) as { approvalId: string };
      assert.equal(await guard.decide(ask.approvalId, { tenantId: 't2', userId: 'admin-of-t2' }, 'approved'), false);
    });

    it('a tool call id left "running" by a crashed process can be retried after a while', async () => {
      await pool.query(
        `INSERT INTO tool_results (tenant_id, tool_call_id, tool, args_hash, status, created_at) VALUES ('t1', 'call-crash', 'refund_order', 'x', 'running', now() - interval '1 hour')`,
      );
      // The hash of the retried call's arguments, so only the crash makes the difference.
      const s = toolGuard.createToolGuard({ pool, tools }).session({ tenantId: 't1', userId: 'u1', sessionId: 'conv-4' });
      await s.call('refund_order', { orderId: 'o-1', amountVnd: 1000 }, { toolCallId: 'call-probe' });
      const hash = (await pool.query(`SELECT args_hash FROM tool_results WHERE tool_call_id = 'call-probe'`)).rows[0].args_hash;
      await pool.query(`UPDATE tool_results SET args_hash = $1 WHERE tool_call_id = 'call-crash'`, [hash]);
      const retried = await s.call('refund_order', { orderId: 'o-1', amountVnd: 1000 }, { toolCallId: 'call-crash' });
      assert.equal(retried.status, 'ok', JSON.stringify(retried));
    });
  });

  // ---------- idempotency-keys ----------

  describe('idempotency-keys', () => {
    it("a request whose stale claim was taken over can't free the new owner's claim when it finally fails", async () => {
      const req = { scope: 'tenant:1/user:1', key: 'k-stale', fingerprint: idem.requestFingerprint('POST', '/charges', { amount: 100 }) };
      let releaseA: (() => void) | undefined;
      const a = idem.runIdempotentExternal(pool, req, () => new Promise((_, reject) => (releaseA = () => reject(new Error('provider timeout')))), { staleAfterSec: 1 });
      a.catch(() => {});
      await waitFor(() => releaseA !== undefined, 'A to hold the claim'); // its handler only runs once the claim is committed
      await sleep(1100); // A's claim is stale now
      let releaseB: (() => void) | undefined;
      const b = idem.runIdempotentExternal(pool, req, () => new Promise((r) => (releaseB = () => r({ status: 201, body: { charge: 'ch_1' } }))), { staleAfterSec: 1 });
      await waitFor(() => releaseB !== undefined, 'B to take the claim over'); // B is now calling the provider
      releaseA!();
      await assert.rejects(a);
      // A third retry arrives while B is still charging: it must wait (409), not charge again.
      await assert.rejects(
        idem.runIdempotentExternal(pool, req, async () => ({ status: 201, body: { charge: 'ch_2' } }), { staleAfterSec: 1 }),
        (e: { status?: number }) => e.status === 409,
      );
      releaseB!();
      assert.equal((await b).status, 201);
    });
  });

  // ---------- job-queue ----------

  describe('job-queue', () => {
    beforeEach(async () => pool.query(`TRUNCATE jobs`));

    it('jobs waiting behind a slow one in the same batch keep their lease', async () => {
      for (let i = 0; i < 3; i++) await jobs.enqueue(pool, { kind: 'slow', queue: 'batch', maxAttempts: 1 });
      let ran = 0;
      const worker = jobs.createWorker({ pool, queue: 'batch', batchSize: 3, leaseSec: 1, handlers: { slow: async () => (await sleep(700), void ran++) } });
      const rescuer = jobs.createWorker({ pool, queue: 'batch', handlers: {} }); // another instance's maintenance
      const maintenance = setInterval(() => rescuer.maintain().catch(() => {}), 100);
      try {
        assert.deepEqual(await worker.processOnce(), ['done', 'done', 'done']);
      } finally {
        clearInterval(maintenance);
      }
      assert.equal(ran, 3);
      assert.equal(await count(`SELECT count(*)::int AS n FROM jobs WHERE status = 'dead'`), 0, 'no job died without running');
    });

    it('stopping the worker hands back the claimed jobs it has not started, without spending an attempt', async () => {
      for (let i = 0; i < 3; i++) await jobs.enqueue(pool, { kind: 'slow', queue: 'stop' });
      const worker = jobs.createWorker({ pool, queue: 'stop', batchSize: 3, handlers: { slow: () => sleep(300) } });
      const ac = new AbortController();
      const running = worker.run({ signal: ac.signal, loops: 1, idleMs: 20, maintainEveryMs: 60_000 });
      await sleep(100); // the first job of the batch is running
      const t0 = performance.now();
      ac.abort();
      await running;
      // About 0.2 s: the rest of the running job. Before the fix it ran the other two as well (about 0.8 s).
      assert.ok(performance.now() - t0 < 500, 'stop waited for the running job only');
      const { rows } = await pool.query(`SELECT status, attempts FROM jobs WHERE queue = 'stop' ORDER BY id`);
      assert.deepEqual(rows, [
        { status: 'done', attempts: 1 },
        { status: 'available', attempts: 0 },
        { status: 'available', attempts: 0 },
      ]);
    });
  });

  // ---------- data-retention-and-erasure ----------

  describe('data-retention-and-erasure', () => {
    beforeEach(async () => pool.query(`TRUNCATE erasure_requests`));
    const store = (erase: (id: string) => Promise<void>): erasure.ExternalStore => ({ name: 'search-index', erase });
    const failing = store(async () => {
      throw new Error('search index unreachable');
    });

    it("two instances processing the same request can't reopen it with the subject already forgotten", async () => {
      const opened = erasure.createDataLifecycle({ pool, inventory: [], stores: [failing], pepper: 'p' });
      const { requestId } = await opened.requestErasure('u-9');
      const slowFail = erasure.createDataLifecycle({ pool, inventory: [], stores: [store(async () => (await sleep(300), Promise.reject(new Error('timeout'))))], pepper: 'p' });
      const ok = erasure.createDataLifecycle({ pool, inventory: [], stores: [store(async () => {})], pepper: 'p' });
      await Promise.all([slowFail.processPending(), sleep(50).then(() => ok.processPending())]);
      const r = (await pool.query(`SELECT subject_id, completed_at FROM erasure_requests WHERE id = $1`, [requestId])).rows[0];
      assert.ok(r.completed_at !== null || r.subject_id !== null, 'an open request still knows whom to erase');
      const seen: Array<string | null> = [];
      await erasure.createDataLifecycle({ pool, inventory: [], stores: [store(async (id) => void seen.push(id))], pepper: 'p' }).processPending();
      assert.ok(!seen.includes(null as unknown as string), `erase() was called with ${JSON.stringify(seen)}`);
    });

    it('processPending counts the requests it completed, also when more than one batch is open', async () => {
      const opened = erasure.createDataLifecycle({ pool, inventory: [], stores: [failing], pepper: 'p' });
      for (let i = 0; i < 105; i++) await opened.requestErasure(`u-${i}`);
      const ok = erasure.createDataLifecycle({ pool, inventory: [], stores: [store(async () => {})], pepper: 'p' });
      assert.deepEqual(await ok.processPending(), { completed: 100, open: 5 });
    });

    it('an anonymize entry that leaves a personal column in place is refused at startup', () => {
      assert.throws(
        () =>
          erasure.createDataLifecycle({
            pool,
            pepper: 'p',
            inventory: [
              {
                table: 'orders',
                subjectColumn: 'user_id',
                personal: ['customer_email', 'shipping_address'],
                onErase: 'anonymize',
                anonymize: { customer_email: "'erased'", user_id: 'NULL' },
              },
            ],
          }),
        /shipping_address/,
      );
    });
  });

  // ---------- agent-safe-db ----------

  describe('agent-safe-db', () => {
    const whoami = { whoami: { description: 'backend pid', sql: 'SELECT pg_backend_pid() AS pid', params: [] } };
    const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: 'u1' };

    it('a database that accepts connections but never answers fails the tool call, instead of hanging it', async () => {
      const sockets = new Set<net.Socket>();
      const hole = net.createServer((s) => sockets.add(s));
      await new Promise<void>((r) => hole.listen(0, '127.0.0.1', r));
      const { port } = hole.address() as net.AddressInfo;
      const db = agentDb.createAgentDb({ connectionString: `postgres://agent:x@127.0.0.1:${port}/kit`, tools: whoami, audit: () => {}, connectTimeoutMs: 300 } as agentDb.AgentDbOptions);
      try {
        const outcome = await Promise.race([db.run('whoami', {}, ctx).then(() => 'answered', () => 'failed'), sleep(2000).then(() => 'still waiting')]);
        assert.equal(outcome, 'failed');
      } finally {
        for (const s of sockets) s.destroy();
        hole.close();
        await db.close().catch(() => {});
      }
    });

    it('the server ending an idle pooled connection (failover, idle_session_timeout) does not crash the process', async () => {
      const db = agentDb.createAgentDb({ connectionString: dbUrl, tools: whoami, audit: () => {} });
      try {
        const before = (await db.run('whoami', {}, ctx)).rows[0].pid;
        await pool.query('SELECT pg_terminate_backend($1)', [before]);
        await sleep(200);
        assert.notEqual((await db.run('whoami', {}, ctx)).rows[0].pid, before);
      } finally {
        await db.close();
      }
    });
  });

  // ---------- rate-limiting ----------

  describe('rate-limiting', () => {
    it('when the breaker cooldown ends, one check probes a dead Redis while the others fall back at once', async () => {
      let calls = 0;
      const hung = { evalsha: () => (calls++, new Promise(() => {})), eval: () => new Promise(() => {}) } as unknown as Redis;
      const rl = limiter.createRateLimiter({ redis: hung, capacity: 10, refillPerSec: 1, failureMode: 'open', timeoutMs: 20, breakerThreshold: 2, breakerCooldownMs: 100 });
      await rl.check('a');
      await rl.check('a');
      await sleep(150);
      calls = 0;
      const t0 = performance.now();
      const results = await Promise.all(Array.from({ length: 20 }, () => rl.check('a')));
      assert.equal(calls, 1, 'one probe');
      assert.ok(results.every((r) => r.source === 'fail-open'));
      assert.ok(performance.now() - t0 < 100);
    });
  });

  // ---------- cache-stampede ----------

  describe('cache-stampede', () => {
    let redis: RedisClient;
    before(() => {
      redis = new RedisClient(REDIS_URL);
    });
    after(() => redis.disconnect());

    it('a cache hit returns the same shape as the miss that filled it', async () => {
      const c = cache.createCache({ redis, prefix: `r3-shape-${Date.now()}`, ttlSec: 60 });
      const miss = await c.get('order:1', async () => ({ id: 1, paidAt: new Date('2026-10-01T08:00:00Z') }));
      const hit = await c.get('order:1', async () => assert.fail('a hit must not load'));
      assert.deepEqual(hit, miss, 'code that passed its tests on misses breaks on hits otherwise');
    });

    it("a value the cache can't encode is served uncached instead of failing the request", async () => {
      const errors: unknown[] = [];
      const c = cache.createCache({ redis, prefix: `r3-bigint-${Date.now()}`, ttlSec: 60, onError: (e) => errors.push(e) });
      assert.deepEqual(await c.get('balance', async () => ({ amount: 10n })), { amount: 10n });
      assert.equal(errors.length, 1, 'reported');
    });

    it('a black-holed Redis costs the timeout a few times, then nothing (breaker)', async () => {
      const hung = { get: () => new Promise(() => {}), set: () => new Promise(() => {}), eval: () => new Promise(() => {}), del: () => new Promise(() => {}) } as unknown as Redis;
      const c = cache.createCache({ redis: hung, prefix: 'r3-hole', ttlSec: 60, timeoutMs: 50, onError: () => {} });
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) await c.get(`k${i}`, async () => i);
      const took = performance.now() - t0;
      assert.ok(took < 400, `20 requests took ${Math.round(took)} ms (50 ms each without a breaker)`);
    });
  });

  // ---------- sse-streaming ----------

  describe('sse-streaming', () => {
    it("after a restart, a client's Last-Event-ID from the old process gets a reset, not someone else's events", async () => {
      const oldProcess = sse.createReplayBuffer<number>(100);
      const ids = [1, 2, 3, 4, 5].map((n) => oldProcess.append(n));
      await sleep(5);
      const newProcess = sse.createReplayBuffer<number>(100); // a deploy restarted the server
      for (let n = 100; n < 105; n++) newProcess.append(n);
      assert.equal(newProcess.since(String(ids[2])), 'reset');
    });
  });

  // ---------- multitenant-postgres ----------

  describe('multitenant-postgres', () => {
    it('the RLS audit flags a tenant table whose only policy lets every row through', async () => {
      await pool.query(`
        CREATE TABLE leaky_notes (id serial PRIMARY KEY, tenant_id uuid NOT NULL, body text);
        ALTER TABLE leaky_notes ENABLE ROW LEVEL SECURITY;
        ALTER TABLE leaky_notes FORCE ROW LEVEL SECURITY;
        CREATE POLICY everyone ON leaky_notes USING (true);`);
      const results = (await pool.query(await readSkillFile('multitenant-postgres', 'rls-audit.sql'))) as unknown as pg.QueryResult[];
      const flagged = results.flatMap((r) => r.rows).some((r) => r.table_name === 'leaky_notes');
      assert.ok(flagged, 'USING (true) is RLS in name only');
    });
  });

  // ---------- rag-evals ----------

  describe('rag-evals', () => {
    it('a retriever that returns the same document twice does not score above 1', async () => {
      const report = await evals.evaluateRetriever([{ id: 'q1', query: 'refund', relevant: ['doc-1'] }], async () => ['doc-1', 'doc-1', 'doc-2'], 3);
      assert.equal(report.recall, 1);
      assert.ok(report.ndcg <= 1 && report.precision <= 1, JSON.stringify(report));
    });

    it("adding hard questions to the golden set is not reported as a regression", async () => {
      const golden = [
        { id: 'q1', query: 'refund', relevant: ['a'] },
        { id: 'q2', query: 'shipping', relevant: ['b'] },
      ];
      const retrieve = async (q: evals.GoldenQuery) => (q.id === 'q3' ? ['x'] : q.relevant);
      const baseline = await evals.evaluateRetriever(golden, retrieve);
      const candidate = await evals.evaluateRetriever([...golden, { id: 'q3', query: 'warranty for refurbished', relevant: ['c'] }], retrieve);
      const result = evals.compareReports(baseline, candidate);
      assert.equal(result.pass, true, JSON.stringify(result.failures));
    });

    it("the judge prompt carries the answer verbatim, whatever characters it contains", () => {
      const answer = "Phí là 10$' một đơn; xem {{context}} và $& trong tài liệu";
      const prompt = judge.fillPrompt({ id: 'x', question: 'Phí?', context: ['Phí là 10$.'], answer });
      assert.ok(prompt.includes(`Answer: ${answer}`), prompt);
      assert.equal(prompt.split('[1] Phí là 10$.').length, 2, 'context inserted once');
    });
  });

  // ---------- llm-observability + pii-redaction ----------

  describe('llm-observability', () => {
    it('a model reply without text (a tool call) does not turn the traced call into an error', async () => {
      const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
      const redactor = redaction.createRedactor();
      const out = await tracing.withLlmSpan(
        provider.getTracer('t'),
        { provider: 'openai', model: 'gpt', messages: [{ role: 'user', content: 'refund order 7' }], tenantId: 't' },
        async () => ({ content: null as unknown as string, usage: { inputTokens: 5, outputTokens: 9 } }),
        { redact: redactor.redactString },
      );
      assert.equal(out.content, null);
    });
  });

  describe('pii-redaction', () => {
    it('a custom detector without the g flag is refused, instead of redacting only the first match', () => {
      assert.throws(() => redaction.createRedactor({ detectors: [{ name: 'ORDER_EMAIL', pattern: /[a-z]+@shop\.vn/ }] }), /global/);
      assert.throws(() => redaction.createRedactor({ detectors: [{ name: 'X', pattern: /x/g, hint: /x/g }] }), /hint/);
    });
  });

  // ---------- zero-downtime-migrations ----------

  describe('zero-downtime-migrations', () => {
    it('a backfill batch that hits a deadlock is retried, not the whole backfill', async () => {
      await pool.query(`
        CREATE TABLE bf (id bigserial PRIMARY KEY, plan text, plan_v2 text);
        INSERT INTO bf (plan) SELECT 'free' FROM generate_series(1, 2500);
        CREATE SEQUENCE bf_deadlocks;
        CREATE FUNCTION bf_flaky() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('bf_deadlocks') = 1 THEN RAISE EXCEPTION 'deadlock detected (simulated)' USING ERRCODE = '40P01'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER bf_flaky BEFORE UPDATE ON bf FOR EACH ROW EXECUTE FUNCTION bf_flaky();`);
      const result = await migrate.backfill(pool, { table: 'bf', set: 'plan_v2 = upper(plan)', where: 'plan_v2 IS NULL', batchSize: 1000, pauseMs: 0 });
      assert.equal(result.updated, 2500);
      assert.equal(await count(`SELECT count(*)::int AS n FROM bf WHERE plan_v2 IS NULL`), 0);
    });

    it('the linter flags ADD COLUMN … NOT NULL without a default (it fails on any non-empty table)', () => {
      const findings = lint.lintMigration(`ALTER TABLE accounts ADD COLUMN region text NOT NULL;`);
      assert.deepEqual(findings.map((f) => f.rule), ['add-column-not-null']);
      assert.deepEqual(lint.lintMigration(`ALTER TABLE accounts ADD COLUMN region text NOT NULL DEFAULT 'vn';`), []);
    });
  });
});
