// Round 4 of the latent-bug review: what users, providers and models actually send. Each hypothesis is a test of
// the behaviour the skill promises, fed with realistic or hostile input (verify/tests/fixtures/user-inputs.ts).
// Every test here failed on 0.5.0. Namespace imports keep this file loadable against older code.
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { fakeEmbedding, toVectorLiteral } from '../support/vectors.ts';
import { serve } from '../support/http.ts';
import { parseEventStream } from '../support/sse-parser.ts';
import { NASTY, NATIONAL_ID_MENTIONS, NOT_PII, PHONE_FORMATS, SECRETS_IN_TEXT } from '../fixtures/user-inputs.ts';
import * as webhooks from '../../../skills/webhook-ingestion/references/webhooks.ts';
import * as outbox from '../../../skills/outbox-pattern/references/outbox.ts';
import * as jobs from '../../../skills/job-queue/references/jobs.ts';
import * as idem from '../../../skills/idempotency-keys/references/idempotency.ts';
import * as toolGuard from '../../../skills/llm-tool-safety/references/tool-guard.ts';
import * as tenantDb from '../../../skills/multitenant-postgres/references/tenant-db.ts';
import * as agentDb from '../../../skills/agent-safe-db/references/agent-db-tool.ts';
import * as sse from '../../../skills/sse-streaming/references/sse.ts';
import * as redaction from '../../../skills/pii-redaction/references/redact.ts';
import * as cache from '../../../skills/cache-stampede/references/cache.ts';
import * as slo from '../../../skills/slo-alerting/references/slo.ts';
import * as hardening from '../../../skills/service-hardening/references/server.ts';

const TENANT = '33333333-3333-4333-8333-333333333333';
let dbUrl: string;
let pool: pg.Pool;
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

/** Opens an SSE stream on a real HTTP connection, lets `send` write to it, and returns the raw bytes received. */
async function captureStream(send: (stream: sse.SseStream) => Promise<void>): Promise<string> {
  let failure: Error | undefined;
  const server = await serve((req, res) => {
    const stream = sse.openSse(req, res, { heartbeatMs: 60_000 });
    send(stream).catch((err: Error) => (failure = err)).finally(() => stream.close());
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    const body = await res.text();
    if (failure) throw failure;
    return body;
  } finally {
    await server.close();
  }
}

describe('latent bugs, round 4: real user input', () => {
  before(async () => {
    dbUrl = await freshDatabase('kit_round4');
    pool = new pg.Pool({ connectionString: dbUrl, max: 8 });
    pool.on('error', () => {});
    for (const [skill, file] of [
      ['webhook-ingestion', 'inbox.sql'],
      ['outbox-pattern', 'outbox.sql'],
      ['job-queue', 'jobs.sql'],
      ['idempotency-keys', 'idempotency.sql'],
      ['llm-tool-safety', 'tool-guard.sql'],
      ['multitenant-postgres', 'schema.sql'],
    ]) {
      await runSqlFile(pool, skill, file);
    }
    await pool.query(`CREATE TABLE orders (id text PRIMARY KEY, note text); CREATE TABLE customers (id text, tenant_id text, PRIMARY KEY (tenant_id, id))`);
    await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Shop')`, [TENANT]);
    const doc = (await pool.query(`INSERT INTO documents (tenant_id, title) VALUES ($1, 'FAQ') RETURNING id`, [TENANT])).rows[0].id;
    await pool.query(`INSERT INTO chunks (tenant_id, document_id, content, embedding) VALUES ($1, $2, 'Thanh toán qua VNPay hoặc MoMo', $3)`, [
      TENANT,
      doc,
      toVectorLiteral(fakeEmbedding(1)),
    ]);
  });
  after(async () => pool?.end());

  // ---------- A NUL character (U+0000) from a user, a provider or a model ----------

  describe('a NUL character is stored, not fatal (Postgres text and jsonb reject U+0000)', () => {
    const stored = 'Nguyễn�Văn A';

    it('webhook-ingestion: a payment event whose customer note holds a NUL is stored and processed', async () => {
      const ingested = await webhooks.ingest(pool, { provider: 'shop', eventId: 'evt-nul', eventType: 'order.paid', payload: { note: NASTY.nul } });
      assert.equal(ingested.inserted, true, 'otherwise the provider retries this event forever');
      const notes: string[] = [];
      const worker = webhooks.createInboxWorker({ pool, handlers: { 'shop:order.paid': async (row) => void notes.push(row.payload.note) } });
      assert.deepEqual(await worker.processOnce(), ['done']);
      assert.deepEqual(notes, [stored]);
    });

    it('outbox-pattern: an order whose note holds a NUL still commits, together with its event', async () => {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(`INSERT INTO orders (id, note) VALUES ('o-nul', $1)`, ['gói kỹ giúp em']);
        await outbox.enqueue(tx, { aggregateType: 'order', aggregateId: 'o-nul', eventType: 'order.placed', payload: { note: NASTY.nul } });
        await tx.query('COMMIT');
      } catch (err) {
        await tx.query('ROLLBACK');
        throw err;
      } finally {
        tx.release();
      }
      assert.equal((await one(`SELECT payload->>'note' AS note FROM outbox WHERE aggregate_id = 'o-nul'`)).note, stored);
    });

    it('job-queue: a job whose payload holds a NUL is enqueued', async () => {
      const id = await jobs.enqueue(pool, { kind: 'send-receipt', payload: { name: NASTY.nul } });
      assert.equal((await one(`SELECT payload->>'name' AS name FROM jobs WHERE id = $1`, [id])).name, stored);
    });

    it('idempotency-keys: a response body holding a NUL is stored, and the retry gets it back', async () => {
      const req = { scope: 'tenant:1/user:1', key: 'k-nul', fingerprint: idem.requestFingerprint('POST', '/orders', { note: NASTY.nul }) };
      const first = await idem.runIdempotent(pool, req, async () => ({ status: 201, body: { note: NASTY.nul } }));
      assert.equal(first.status, 201, 'otherwise the order rolls back and every retry fails the same way');
      const retry = await idem.runIdempotent(pool, req, async () => assert.fail('ran twice'));
      assert.deepEqual(retry, { status: 201, body: { note: stored }, headers: undefined, replayed: true });
    });

    it('llm-tool-safety: a model argument holding a NUL reaches the approval queue', async () => {
      const guard = toolGuard.createToolGuard({
        pool,
        tools: [
          {
            name: 'close_account',
            tier: 'destructive',
            description: 'Close an account',
            params: { customerId: { type: 'string', required: true }, reason: { type: 'string', maxLength: 200 } },
            run: async () => ({ closed: true }),
          },
        ],
      });
      const res = await guard.session({ tenantId: 't1', userId: 'u1', sessionId: 'nul' }).call('close_account', { customerId: 'c-1', reason: NASTY.nul });
      assert.equal(res.status, 'approval_required');
    });

    it('multitenant-postgres: a search query with a NUL (%00 in a URL) returns results', async () => {
      const hits = await tenantDb.withTenant(pool, TENANT, (c) => tenantDb.hybridSearch(c, { embedding: fakeEmbedding(1), query: `thanh toán${'\u0000'}` }));
      assert.equal(hits.length, 1);
    });
  });

  // ---------- Inputs that are judged before they reach the database ----------

  describe('agent-safe-db: tool parameters are judged before the database sees them', () => {
    const tools = {
      echo_text: { description: 'echo', sql: 'SELECT $1::text AS v', params: [{ name: 'q', type: 'string' as const, description: 'text' }] },
      orders_on: { description: 'by day', sql: 'SELECT $1::date AS v', params: [{ name: 'day', type: 'date' as const, description: 'day' }] },
    };
    const ctx = { tenantId: TENANT, userId: 'u1' };

    it('a string parameter holding a NUL is a ToolInputError, not a database error', async () => {
      const db = agentDb.createAgentDb({ connectionString: dbUrl, tools, audit: () => {} });
      try {
        await assert.rejects(db.run('echo_text', { q: NASTY.nul }, ctx), agentDb.ToolInputError);
      } finally {
        await db.close();
      }
    });

    it('an impossible calendar date (2026-02-31, 2026-02-29) is a ToolInputError, not a database error', async () => {
      const db = agentDb.createAgentDb({ connectionString: dbUrl, tools, audit: () => {} });
      try {
        for (const day of ['2026-02-31', '2026-02-29', '2026-04-31']) await assert.rejects(db.run('orders_on', { day }, ctx), agentDb.ToolInputError, day);
        assert.equal(String((await db.run('orders_on', { day: '2028-02-29' }, ctx)).rows.length), '1', 'a real leap day still passes');
      } finally {
        await db.close();
      }
    });
  });

  describe('llm-tool-safety: model output is validated, never trusted', () => {
    const refund: toolGuard.ToolDef = {
      name: 'refund_order',
      tier: 'destructive',
      description: 'Refund',
      // Written the way people often write it: without ^ and $.
      params: { orderId: { type: 'string', required: true, pattern: /o-\d+/ } },
      run: async () => ({ refunded: true }),
    };
    beforeEach(async () => pool.query(`TRUNCATE tool_approvals, tool_results, tool_audit, tool_sessions`));

    it('a pattern has to match the whole value: "o-1\'; DROP TABLE refunds; --" is refused', async () => {
      const s = toolGuard.createToolGuard({ pool, tools: [refund] }).session({ tenantId: 't1', userId: 'u1', sessionId: 's' });
      assert.deepEqual(await s.call('refund_order', { orderId: NASTY.sqlInjection }), { status: 'rejected', reason: '"orderId" has the wrong format' });
    });

    it('an approval id the model made up is rejected, not a database error', async () => {
      const s = toolGuard.createToolGuard({ pool, tools: [refund] }).session({ tenantId: 't1', userId: 'u1', sessionId: 's' });
      assert.deepEqual(await s.call('refund_order', { orderId: 'o-1' }, { approvalId: 'approved-by-admin' }), { status: 'rejected', reason: 'no such approval for this session' });
    });

    it('decide() with a malformed approval id (a URL edited by hand) returns false', async () => {
      const guard = toolGuard.createToolGuard({ pool, tools: [refund] });
      assert.equal(await guard.decide('../../admin', { tenantId: 't1', userId: 'admin' }, 'approved'), false);
    });
  });

  // ---------- Framing that content must not be able to break ----------

  describe('sse-streaming: content cannot break the event framing', () => {
    it('data holding a bare CR stays data: it cannot set the id or the event type', async () => {
      const body = await captureStream((stream) => stream.send({ data: NASTY.cr }).then(() => {}));
      const { events, lastEventId } = parseEventStream(body);
      assert.deepEqual(
        events.map((e) => [e.type, e.data]),
        [['message', 'Xin chào\nid: 999\nevent: admin']],
      );
      assert.equal(lastEventId, '', 'a client would otherwise reconnect claiming id 999');
    });

    it('an id or an event name holding a line break is refused', async () => {
      await assert.rejects(captureStream((stream) => stream.send({ id: '7\nevent: admin', data: 'x' }).then(() => {})), TypeError);
      await assert.rejects(captureStream((stream) => stream.send({ event: 'order\r\ndata: injected', data: 'x' }).then(() => {})), TypeError);
    });
  });

  // ---------- Redaction of what people and systems actually write ----------

  describe('pii-redaction: what Vietnamese users and real systems write', () => {
    const r = redaction.createRedactor();
    const digits = (s: string) => s.replace(/\D/g, '');

    it('every common way of writing a mobile number', () => {
      for (const phone of PHONE_FORMATS) {
        const out = r.redactString(`Liên hệ ${phone} nhé`);
        assert.ok(!digits(out).includes('1234567'), `${phone} → ${out}`);
      }
    });

    it('CMND numbers, and CCCD numbers written with spaces, next to their label', () => {
      for (const { text, id } of NATIONAL_ID_MENTIONS) {
        const out = r.redactString(text);
        assert.ok(!out.includes(id) && !digits(out).includes(digits(id)), `${text} → ${out}`);
      }
    });

    it('secrets in connection strings, URLs and provider tokens', () => {
      for (const { text, secret } of SECRETS_IN_TEXT) {
        const out = r.redactString(text);
        assert.ok(!out.includes(secret), `${text} → ${out}`);
      }
    });

    it('lines with nothing personal in them come out unchanged (ids, timings, cache keys, hashes)', () => {
      for (const line of NOT_PII) assert.equal(r.redactString(line), line);
    });

    it('an email address with Vietnamese letters', () => {
      assert.ok(!r.redactString('email: nguyễn.văn.a@ví-dụ.vn').includes('nguyễn'));
    });

    it('an object whose getter throws (an ORM entity with a lazy relation) is logged, not thrown', () => {
      const entity = {
        id: 7,
        email: 'a@example.com',
        get orders(): never {
          throw new Error('relation "orders" was not loaded');
        },
      };
      assert.deepEqual(r.redactValue(entity), { id: 7, email: '[EMAIL]', orders: '[UNREADABLE]' });
    });

    it('a database error keeps its code and its detail, with the duplicated email redacted', () => {
      const err = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
        code: '23505',
        detail: 'Key (email)=(lan@shop.vn) already exists.',
        config: { headers: { Authorization: 'Bearer abcdefgh12345678' } }, // what an HTTP client's error carries
      });
      const out = r.redactValue(err) as Record<string, unknown>;
      assert.equal(out.code, '23505');
      assert.equal(out.detail, 'Key (email)=([EMAIL]) already exists.');
      assert.ok(!JSON.stringify(out).includes('abcdefgh12345678'));
    });
  });

  // ---------- Keys and configuration built from data ----------

  describe('keys and configuration built from data', () => {
    it('cache-stampede: tenantKey keeps tenants apart even when an id contains ":"', () => {
      assert.notEqual(cache.tenantKey('org:1', 'dashboard'), cache.tenantKey('org', '1:dashboard'));
      assert.notEqual(cache.tenantKey('a', 'b:c'), cache.tenantKey('a:b', 'c'));
    });

    it('slo-alerting: an error-ratio query without {{window}} is refused (five identical windows otherwise)', () => {
      assert.throws(
        () => slo.prometheusRules([{ name: 'checkout', service: 'shop', objective: 0.999, errorRatio: 'sum(rate(http_errors_total[5m])) / sum(rate(http_requests_total[5m]))' }]),
        /\{\{window\}\}/,
      );
    });

    it('slo-alerting: an objective written as a percentage (99.9) is refused', () => {
      assert.throws(
        () => slo.prometheusRules([{ name: 'checkout', service: 'shop', objective: 99.9, errorRatio: 'sum(rate(e[{{window}}])) / sum(rate(r[{{window}}]))' }]),
        /objective/,
      );
    });
  });

  // ---------- Found by driving the skills end to end (journeys/) and by generated input (properties/) ----------

  describe('found by the journeys and the property tests', () => {
    it('service-hardening: a clean shutdown leaves no timer behind, so the process exits now, not after shutdownGraceMs', async () => {
      const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      const before = timers();
      const app = hardening.createHardenedServer({ drainDelayMs: 0, handler: (_req, res) => void res.end('ok') });
      await app.listen(0, '127.0.0.1');
      assert.deepEqual(await app.shutdown(), { forced: false });
      assert.equal(timers(), before);
    });

    it('llm-tool-safety: a write whose result was cut mid-emoji is stored, and the retry replays it instead of running again', async () => {
      await pool.query(`TRUNCATE tool_approvals, tool_results, tool_audit, tool_sessions`);
      let runs = 0;
      const note = 'Đã hoàn tiền 😀 cho đơn o-1';
      const refund: toolGuard.ToolDef = {
        name: 'refund',
        tier: 'write',
        description: 'Refund',
        params: {},
        run: async () => ({ runs: ++runs, preview: note.slice(0, note.indexOf('😀') + 1) }), // a preview cut at a fixed length
      };
      const s = toolGuard.createToolGuard({ pool, tools: [refund] }).session({ tenantId: 't1', userId: 'u1', sessionId: 's' });
      assert.equal((await s.call('refund', {}, { toolCallId: 'c-1' })).status, 'ok');
      const retry = await s.call('refund', {}, { toolCallId: 'c-1' });
      assert.deepEqual([retry.status, runs], ['ok', 1]);
    });

    it('llm-tool-safety: decide() takes approved or denied only; "used" from a form no longer marks an approval used', async () => {
      await pool.query(`TRUNCATE tool_approvals, tool_results, tool_audit, tool_sessions`);
      const destructive: toolGuard.ToolDef = { name: 'wipe', tier: 'destructive', description: 'Wipe', params: {}, run: async () => ({}) };
      const guard = toolGuard.createToolGuard({ pool, tools: [destructive] });
      const held = await guard.session({ tenantId: 't1', userId: 'u1', sessionId: 's' }).call('wipe', {});
      const approvalId = (held as { approvalId: string }).approvalId;
      for (const decision of ['used', 'pending', 'approve']) {
        await assert.rejects(guard.decide(approvalId, { tenantId: 't1', userId: 'u2' }, decision as 'approved'), TypeError);
      }
      assert.equal((await pool.query(`SELECT status FROM tool_approvals WHERE id = $1`, [approvalId])).rows[0].status, 'pending');
    });
  });
});
