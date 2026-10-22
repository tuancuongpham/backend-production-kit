// Properties of the code that takes model output and user input. Whatever arrives is either accepted, and then safe
// to use (the database takes it), or refused with the error meant for it, which the model or the user can act on:
// never a database error, never a crash.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { anyText, dateLike, fc, modelValue } from '../support/arbitraries.ts';
import { createToolGuard, ToolArgumentError, validateArgs, type ToolDef } from '../../../skills/llm-tool-safety/references/tool-guard.ts';
import { createAgentDb, ToolInputError, type ToolDef as AgentToolDef } from '../../../skills/agent-safe-db/references/agent-db-tool.ts';
import { IdempotencyError, parseIdempotencyKey, requestFingerprint } from '../../../skills/idempotency-keys/references/idempotency.ts';
import { createReplayBuffer } from '../../../skills/sse-streaming/references/sse.ts';

const REFUND: ToolDef = {
  name: 'refund_order',
  tier: 'write',
  description: 'Refund an order',
  params: {
    orderId: { type: 'string', required: true, pattern: /o-\d+/, maxLength: 20 },
    amountVnd: { type: 'integer', required: true, min: 1, max: 5_000_000 },
    share: { type: 'number', min: 0, max: 1 },
    notify: { type: 'boolean' },
    reason: { type: 'enum', values: ['damaged', 'late', 'other'] },
  },
  run: async (a) => ({ refundedVnd: a.amountVnd }),
};

/** Arguments as models send them: mostly close to the schema, often not quite, sometimes something else entirely. */
const refundArgs = fc.oneof(
  fc.record(
    {
      orderId: fc.oneof(fc.stringMatching(/^o-\d{1,8}$/), modelValue),
      amountVnd: fc.oneof(fc.integer({ min: -1, max: 6_000_000 }), modelValue),
      share: fc.oneof(fc.double({ min: -0.5, max: 1.5 }), modelValue),
      notify: fc.oneof(fc.boolean(), modelValue),
      reason: fc.oneof(fc.constantFrom('damaged', 'late', 'other', 'Damaged'), modelValue),
    },
    { requiredKeys: [] },
  ),
  fc.dictionary(fc.oneof(anyText(12), fc.constantFrom('__proto__', 'constructor', 'toString', 'orderId')), modelValue),
  modelValue,
);

/** The same JSON with every object's keys in reverse order: how another client library may serialize it. */
const reordered = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(reordered) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reordered(x)])) : v;

describe('properties: model output and user input', () => {
  let pool: pg.Pool;
  let dbUrl: string;

  before(async () => {
    dbUrl = await freshDatabase('kit_properties_input');
    pool = new pg.Pool({ connectionString: dbUrl, max: 5 });
    await runSqlFile(pool, 'llm-tool-safety', 'tool-guard.sql');
  });
  after(async () => pool?.end());

  it('validateArgs: the tool gets arguments that match its schema, or the model gets a ToolArgumentError', () => {
    fc.assert(
      fc.property(refundArgs, (raw) => {
        let args: Record<string, unknown>;
        try {
          args = validateArgs(REFUND, raw);
        } catch (err) {
          assert.ok(err instanceof ToolArgumentError, `${JSON.stringify(raw)} → ${err}`);
          return;
        }
        assert.ok(typeof args.orderId === 'string' && /^o-\d+$/.test(args.orderId) && args.orderId.length <= 20, JSON.stringify(args));
        assert.ok(Number.isInteger(args.amountVnd) && (args.amountVnd as number) >= 1 && (args.amountVnd as number) <= 5_000_000);
        if (args.share !== undefined) assert.ok(typeof args.share === 'number' && args.share >= 0 && args.share <= 1);
        if (args.notify !== undefined) assert.equal(typeof args.notify, 'boolean');
        if (args.reason !== undefined) assert.ok(['damaged', 'late', 'other'].includes(args.reason as string));
        for (const key of Object.keys(args)) assert.ok(Object.hasOwn(REFUND.params, key), key);
      }),
    );
  });

  it('ToolSession.call: any arguments and any tool-call id give a result for the model, never an exception', async () => {
    const guard = createToolGuard({ pool, tools: [REFUND] });
    const session = guard.session({ tenantId: 't1', userId: 'u1', sessionId: 'properties' });
    // Valid arguments too, or nearly every call is refused before its tool-call id is used.
    const valid = fc.record({ orderId: fc.stringMatching(/^o-\d{1,8}$/), amountVnd: fc.integer({ min: 1, max: 5_000_000 }) });
    await fc.assert(
      fc.asyncProperty(fc.oneof(valid, refundArgs), fc.option(anyText(40), { nil: undefined }), async (raw, toolCallId) => {
        const result = await session.call('refund_order', raw, { toolCallId });
        assert.ok(['ok', 'rejected', 'approval_required'].includes(result.status), JSON.stringify(result));
      }),
      { numRuns: 200 },
    );
  });

  it('ToolGuard.decide: an approval id from a URL, however it was edited, is an unknown approval, never a database error', async () => {
    const guard = createToolGuard({ pool, tools: [REFUND] });
    await fc.assert(
      fc.asyncProperty(fc.oneof(anyText(60), fc.uuid()), async (approvalId) => {
        assert.equal(await guard.decide(approvalId, { tenantId: 't1', userId: 'u2' }, 'approved'), false);
      }),
      { numRuns: 200 },
    );
  });

  describe('agent-safe-db: a parameter the database would refuse is refused first, as a ToolInputError', () => {
    const probe = (sql: string, type: AgentToolDef['params'][number]['type']): AgentToolDef => ({
      description: 'probe',
      sql,
      params: [{ name: 'v', type, description: 'the value under test', maxLength: 500 }],
    });
    const tools = {
      text: probe('SELECT $1::text AS v', 'string'),
      timestamp: probe('SELECT $1::timestamptz AS v', 'date'),
      day: probe('SELECT $1::date AS v', 'date'),
      uuid: probe('SELECT $1::uuid AS v', 'uuid'),
      number: probe('SELECT $1::numeric AS v', 'number'),
    };
    const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: 'u1' };
    let db: ReturnType<typeof createAgentDb>;
    before(() => {
      db = createAgentDb({ connectionString: dbUrl, tools, audit: () => {} });
    });
    after(async () => db?.close());

    const accepted = async (tool: keyof typeof tools, v: unknown) => {
      try {
        await db.run(tool, { v }, ctx);
      } catch (err) {
        assert.ok(err instanceof ToolInputError, `${tool}(${JSON.stringify(v)}) → ${(err as Error).message}`);
      }
    };

    it('any value for any parameter type', async () => {
      await fc.assert(fc.asyncProperty(fc.constantFrom(...(Object.keys(tools) as Array<keyof typeof tools>)), modelValue, accepted), { numRuns: 400 });
    });

    it('dates as models write them: impossible days, a 24th hour, odd offsets', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom('timestamp' as const, 'day' as const), dateLike, accepted),
        { numRuns: 1000 },
      );
    });
  });

  it('parseIdempotencyKey: a header value is the key, or a 400; never another error', () => {
    fc.assert(
      fc.property(fc.oneof(anyText(300), fc.stringMatching(/^[\x21-\x7e]{1,300}$/), fc.array(anyText(10), { maxLength: 3 })), (header) => {
        try {
          assert.equal(parseIdempotencyKey(header), header);
          assert.ok(typeof header === 'string' && header.length >= 1 && header.length <= 255);
        } catch (err) {
          assert.ok(err instanceof IdempotencyError && err.status === 400, String(err));
        }
      }),
    );
  });

  it('requestFingerprint: the same JSON with its keys in another order, or the method in lower case, is the same request', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), fc.constantFrom('/v1/orders', '/v1/orders?page=2'), (body, path) => {
        assert.equal(requestFingerprint('post', path, reordered(body)), requestFingerprint('POST', path, body));
      }),
    );
  });

  it('ReplayBuffer.since: any Last-Event-ID gives the newer events, in order and without a gap, or a reset', () => {
    const feed = createReplayBuffer<number>(50);
    const ids = Array.from({ length: 80 }, (_, i) => feed.append(i));
    const lastEventId = fc.oneof(anyText(30), fc.integer().map(String), fc.constantFrom(...ids.map(String)), fc.constantFrom(...ids.map((id) => ` ${id}`)));
    fc.assert(
      fc.property(lastEventId, (header) => {
        const missed = feed.since(header);
        if (missed === 'reset' || missed.length === 0) return;
        const last = Number(header);
        assert.equal(missed[0].id, last + 1, 'the first event after the last one seen: no gap');
        missed.forEach((e, i) => i > 0 && assert.equal(e.id, missed[i - 1].id + 1));
      }),
    );
  });
});
