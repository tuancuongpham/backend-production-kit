// Properties of what the kit writes for others to read back: event streams, signatures, cache keys, values stored
// in Postgres, prompts, alert rules. Over generated content, what goes in comes out as it went in, or as documented.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { freshDatabase } from '../support/infra.ts';
import { anyText, fc, textUnit } from '../support/arbitraries.ts';
import { parseEventStream } from '../support/sse-parser.ts';
import { formatEvent } from '../../../skills/sse-streaming/references/sse.ts';
import { verifyHmacHex, verifyTimestampedSignature } from '../../../skills/webhook-ingestion/references/webhooks.ts';
import { tenantKey } from '../../../skills/cache-stampede/references/cache.ts';
import { pgJson, pgText } from '../../../shared/pg-values.ts';
import { fillPrompt } from '../../../skills/rag-evals/references/judge.ts';
import { lintMigration } from '../../../skills/zero-downtime-migrations/references/lint.ts';
import { prometheusRules } from '../../../skills/slo-alerting/references/slo.ts';

/** Text without a line break: what an SSE id or event name may be. */
const oneLine = anyText(20).filter((s) => !/[\r\n]/.test(s));
/** What Postgres gives back for a stored string: NUL and lone surrogates become U+FFFD, the rest is untouched. */
const asStored = (s: string) => s.toWellFormed().replaceAll('\u0000', '�');
const storedJson = (v: unknown): unknown =>
  typeof v === 'string'
    ? asStored(v)
    : Array.isArray(v)
      ? v.map(storedJson)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [asStored(k), storedJson(x)]))
        : v;

describe('properties: formats', () => {
  it('sse: any text sent as data reaches the browser as it was sent (a CR or CRLF arrives as LF), with its id and event name', () => {
    fc.assert(
      fc.property(anyText(120), fc.option(oneLine, { nil: undefined }), fc.option(oneLine.filter((s) => !s.includes('\u0000')), { nil: undefined }), (data, event, id) => {
        const { events, lastEventId } = parseEventStream(formatEvent({ data, event, id }));
        assert.equal(events.length, 1);
        assert.equal(events[0].data, data.replace(/\r\n|\r/g, '\n'));
        assert.equal(events[0].type, event || 'message');
        assert.equal(lastEventId, id ?? '');
      }),
    );
  });

  it('sse: any value sent as data, other than a string (sent as is), parses back to the same value', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3, stringUnit: textUnit }).filter((v) => typeof v !== 'string'), (value) => {
        const { events } = parseEventStream(formatEvent({ data: value }));
        assert.deepEqual(JSON.parse(events[0].data), JSON.parse(JSON.stringify(value)));
      }),
    );
  });

  it('sse: an id or event name holding a line break is refused, never written', () => {
    fc.assert(
      fc.property(anyText(10), fc.constantFrom('\r', '\n', '\r\n'), anyText(10), fc.constantFrom('id', 'event'), (before, br, after, field) => {
        assert.throws(() => formatEvent({ data: 'x', [field]: `${before}${br}${after}` }), TypeError);
      }),
    );
  });

  it('webhooks: a correctly signed body verifies within the tolerance; any other body, or any garbage header, does not', () => {
    const NOW = 1_790_000_000;
    const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
    fc.assert(
      fc.property(anyText(200), anyText(200), fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: -299, max: 299 }), anyText(80), (body, other, secret, skew, garbage) => {
        const header = sign(secret, NOW + skew, body);
        assert.equal(verifyTimestampedSignature({ secret, rawBody: body, header, nowSec: NOW }), true);
        // The bytes are what is signed: two strings that encode to the same UTF-8 (lone surrogates) are the same body.
        if (!Buffer.from(other).equals(Buffer.from(body))) assert.equal(verifyTimestampedSignature({ secret, rawBody: other, header, nowSec: NOW }), false);
        assert.equal(verifyTimestampedSignature({ secret, rawBody: body, header: garbage, nowSec: NOW }), false);
        assert.equal(typeof verifyHmacHex(secret, body, garbage), 'boolean');
      }),
    );
  });

  it('cache: tenantKey never throws, and two different (tenant, parts) never share a key, however ":" splits them', () => {
    // Segments joined with ":" and split at different points: the collisions an unescaped join would have.
    fc.assert(
      fc.property(fc.array(anyText(6), { minLength: 2, maxLength: 5 }), (segments) => {
        const keys = new Map<string, string>();
        for (let at = 1; at < segments.length; at++) {
          const tenant = segments.slice(0, at).join(':');
          const parts = [segments.slice(at).join(':')];
          const key = tenantKey(tenant, ...parts);
          const tuple = JSON.stringify([tenant, ...parts].map((s) => s.toWellFormed()));
          const seen = keys.get(key);
          assert.ok(seen === undefined || seen === tuple, `${seen} and ${tuple} share ${key}`);
          keys.set(key, tuple);
        }
      }),
    );
  });

  it('rag-evals: the question, the answer and each context chunk appear in the judge prompt exactly as written', () => {
    fc.assert(
      fc.property(anyText(), anyText(), fc.array(anyText(), { maxLength: 3 }), (question, answer, context) => {
        const prompt = fillPrompt({ id: 'q', question, answer, context });
        assert.ok(prompt.includes(question) && prompt.includes(answer));
        context.forEach((chunk, i) => assert.ok(prompt.includes(`[${i + 1}] ${chunk}`)));
      }),
    );
  });

  it('zero-downtime-migrations: the linter finishes on any input, SQL-shaped or not, and never throws', () => {
    const fragments = ['ALTER TABLE t ', 'ADD COLUMN c int ', 'DEFAULT now() ', 'NOT NULL ', 'CREATE INDEX i ON t (c)', ';', '--', '\n', '/*', '*/', "'", "''", '$$', '$fn$', 'BEGIN', 'DROP ', 'RENAME ', '"', ' '];
    const sqlish = fc.array(fc.oneof(fc.constantFrom(...fragments), anyText(5)), { maxLength: 40 }).map((xs) => xs.join(''));
    fc.assert(
      fc.property(fc.oneof(sqlish, anyText(300)), (sql) => {
        for (const finding of lintMigration(sql)) assert.ok(finding.statement.length <= 120);
      }),
    );
  });

  it('slo-alerting: every valid SLO gives five recording rules and three alerts, with every {{window}} filled', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_.:-]{1,40}$/), fc.double({ min: 0.931, max: 0.99999, noNaN: true }), (name, objective) => {
        const errorRatio = 'sum(rate(http_requests_total{code=~"5.."}[{{window}}])) / sum(rate(http_requests_total[{{window}}]))';
        const [group] = prometheusRules([{ name, service: 'shop', objective, errorRatio }]).groups;
        assert.equal(group.rules.length, 8);
        assert.ok(group.rules.every((r) => !r.expr.includes('{{window}}')));
      }),
    );
  });

  describe('postgres: values from users and models are stored, and read back as documented', () => {
    let pool: pg.Pool;
    before(async () => {
      pool = new pg.Pool({ connectionString: await freshDatabase('kit_properties_formats'), max: 3 });
    });
    after(async () => pool?.end());

    it('pgJson: any JSON value is accepted by jsonb and reads back equal, with NUL and lone surrogates as U+FFFD', async () => {
      await fc.assert(
        fc.asyncProperty(fc.jsonValue({ maxDepth: 3, stringUnit: textUnit }), async (value) => {
          const { rows } = await pool.query('SELECT $1::jsonb AS v', [pgJson(value)]);
          assert.deepEqual(rows[0].v, storedJson(JSON.parse(JSON.stringify(value))));
        }),
        { numRuns: 300 },
      );
    });

    it('pgText: any text is accepted by a text column and reads back equal, with NUL and lone surrogates as U+FFFD', async () => {
      await fc.assert(
        fc.asyncProperty(anyText(200), async (text) => {
          const { rows } = await pool.query('SELECT $1::text AS v', [pgText(text)]);
          assert.equal(rows[0].v, asStored(text));
        }),
        { numRuns: 300 },
      );
    });
  });
});
