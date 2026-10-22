// Properties of the redactor, over generated input: personal data written any of the ways people write it does not
// survive, anywhere in a line or a logged object; and nothing a log line can contain makes it throw or redact again
// what it already redacted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anyText, filler, fc, pii } from '../support/arbitraries.ts';
import { createRedactor } from '../../../skills/pii-redaction/references/redact.ts';

const plain = createRedactor();
const correlated = createRedactor({ hmacKey: 'test-key' }); // placeholders carry a short hash: [EMAIL:3f9a1c]
const PLACEHOLDER = /\[[A-Z_]{1,32}(?::[0-9a-f]{6})?\]/g;

/** What is left of the line once placeholders are taken out: the filler has no digits and no @, so nothing should be. */
const leftovers = (out: string) => out.replace(PLACEHOLDER, ' ').match(/[\d@]/g) ?? [];

/** A sentence with personal data in it: "Liên hệ 0901 234 567 nhé , email lan@shop.vn". */
const sentence = fc.tuple(fc.array(fc.tuple(filler, pii), { minLength: 1, maxLength: 3 }), filler).map(([parts, end]) => ({
  line: `${parts.map(([before, p]) => `${before} ${p.text}`).join(' ')} ${end}`,
  pii: parts.map(([, p]) => p),
}));

/** The same line wrapped in a logged object: { user: { order: [{ note: "…" }] } }. */
const loggedObject = fc.tuple(sentence, fc.array(fc.constantFrom('user', 'order', 'items', 'meta', 'context'), { maxLength: 5 })).map(([s, path]) => {
  let value: unknown = { note: s.line };
  for (const key of path) value = key === 'items' ? [value] : { [key]: value };
  return { value, pii: s.pii };
});

const SENSITIVE_KEYS = ['password', 'PASSWORD', 'pwd', 'token', 'access_token', 'refreshToken', 'authorization', 'Cookie', 'api_key', 'x-api-key', 'cvv', 'otp', 'pin', 'private_key', 'stripe_secret'];

describe('properties: pii-redaction', () => {
  it('phones, emails, cards and national ids, written any way people write them, leave no digit and no @ behind', () => {
    fc.assert(
      fc.property(sentence, ({ line, pii }) => {
        for (const redactor of [plain, correlated]) {
          const out = redactor.redactString(line);
          assert.deepEqual(leftovers(out), [], `${pii.map((p) => p.kind).join(', ')} in ${JSON.stringify(line)} → ${JSON.stringify(out)}`);
        }
      }),
    );
  });

  it('inside a logged object, at any depth, the same data leaves nothing behind either', () => {
    fc.assert(
      fc.property(loggedObject, ({ value }) => {
        assert.deepEqual(leftovers(JSON.stringify(plain.redactValue(value))), []);
      }),
    );
  });

  it('redacting twice changes nothing more: placeholders are never redacted again', () => {
    fc.assert(
      fc.property(fc.oneof(anyText(200), sentence.map((s) => s.line)), (text) => {
        for (const redactor of [plain, correlated]) {
          const once = redactor.redactString(text);
          assert.equal(redactor.redactString(once), once);
        }
      }),
    );
  });

  it('a value under a sensitive key never reaches the output, at any depth', () => {
    const marker = 'value-that-must-not-be-logged';
    fc.assert(
      fc.property(fc.constantFrom(...SENSITIVE_KEYS), fc.jsonValue({ maxDepth: 2 }), fc.array(fc.constantFrom('req', 'headers', 'body', 'items'), { maxLength: 4 }), (key, noise, path) => {
        let value: unknown = { [key]: marker, noise };
        for (const p of path) value = p === 'items' ? [value] : { [p]: value };
        assert.ok(!JSON.stringify(plain.redactValue(value)).includes(marker));
      }),
    );
  });

  it('any value at all never makes it throw: bigints, maps, sets, typed arrays, cycles, throwing getters and proxies', () => {
    const anything = fc.anything({
      withBigInt: true,
      withMap: true,
      withSet: true,
      withDate: true,
      withTypedArray: true,
      withSparseArray: true,
      withNullPrototype: true,
      withBoxedValues: true,
      withObjectString: true,
    });
    fc.assert(
      fc.property(anything, (v) => {
        const hostile: Record<string, unknown> = {
          v,
          get lazy(): unknown {
            throw new Error('relation not loaded');
          },
          proxy: new Proxy({}, { ownKeys: () => { throw new Error('revoked'); } }),
        };
        hostile.self = hostile;
        plain.redactValue(v);
        plain.redactValue(hostile);
        // An error from a library that sets odd things: any value as its message, name, stack, code or detail.
        const odd = Object.assign(new Error('boom'), { cause: hostile, code: v, detail: v });
        for (const field of ['message', 'name', 'stack']) Object.defineProperty(odd, field, { value: v });
        plain.redactValue(odd);
        plain.redactValue(new Map([[v, v]]));
      }),
    );
  });
});
