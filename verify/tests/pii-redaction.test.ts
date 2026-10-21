import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, luhnValid, pinoRedactionOptions } from '../../skills/pii-redaction/references/redact.ts';

const r = createRedactor();

// Fixture-driven: each row is [input, expected]. Add a row for every leak you ever find in prod.
const cases: Array<[string, string]> = [
  ['contact alice.nguyen+vip@example.com.vn now', 'contact [EMAIL] now'],
  ['call 0901234567 or +84 912 345 678', 'call [PHONE] or [PHONE]'],
  ['sđt: 090.123.4567', 'sđt: [PHONE]'],
  ['CCCD 001099012345 issued', 'CCCD [NATIONAL_ID] issued'],
  ['card 4111 1111 1111 1111 exp 12/29', 'card [CARD] exp 12/29'],
  ['card 4111-1111-1111-1111', 'card [CARD]'],
  ['Authorization: Bearer abc.def-ghi_jkl123', 'Authorization: [BEARER]'],
  ['token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'token=[JWT]'],
  // Built at runtime so the source never contains strings that look like real keys (secret scanners).
  ['key ' + ['sk', 'live', 'FAKEKEYfakekeyFAKEKEY00'].join('_'), 'key [API_KEY]'],
  ['openai ' + ['sk', 'proj', 'fakefakefakefakefakefake'].join('-'), 'openai [API_KEY]'],
];

// Things that look numeric but must NOT be redacted (false positives make logs useless).
const keep = [
  'order 1234567890123 shipped', // 13 digits, fails Luhn
  'invoice #2024000123',
  'latency 1532ms, status 200, user_id 42',
  'trace 4bf92f3577b34da6a3ce929d0e0e4736',
  'version 1.2.3 build 20261021',
];

describe('pii-redaction', () => {
  for (const [input, expected] of cases) {
    it(`redacts: ${expected}`, () => assert.equal(r.redactString(input), expected));
  }
  for (const input of keep) {
    it(`keeps: ${input}`, () => assert.equal(r.redactString(input), input));
  }

  it('luhn check', () => {
    assert.equal(luhnValid('4111111111111111'), true);
    assert.equal(luhnValid('4111111111111112'), false);
  });

  it('drops values under sensitive keys and recurses into objects/arrays', () => {
    const out = r.redactValue({
      user: { email: 'bob@example.com', password: 'hunter2', profile: { phone: '0912345678' } },
      headers: { Authorization: 'Bearer xyzxyzxyzxyz', cookie: 'sid=1' },
      items: ['ok', 'mail me at x@y.io'],
      apiKey: 'whatever',
      count: 3,
    }) as any;
    assert.equal(out.user.email, '[EMAIL]');
    assert.equal(out.user.password, '[REDACTED]');
    assert.equal(out.user.profile.phone, '[PHONE]');
    assert.equal(out.headers.Authorization, '[REDACTED]');
    assert.equal(out.headers.cookie, '[REDACTED]');
    assert.deepEqual(out.items, ['ok', 'mail me at [EMAIL]']);
    assert.equal(out.apiKey, '[REDACTED]');
    assert.equal(out.count, 3);
  });

  it('handles errors, cycles and depth without throwing', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const err = new Error('failed for bob@example.com');
    const out = r.redactValue({ a, err }) as any;
    assert.equal(out.a.self, '[CIRCULAR]');
    assert.equal(out.err.message, 'failed for [EMAIL]');
    assert.ok(!String(out.err.stack).includes('bob@example.com'));
    let deep: any = 'x';
    for (let i = 0; i < 20; i++) deep = { deep };
    assert.doesNotThrow(() => r.redactValue(deep));
  });

  it('does not mutate the input', () => {
    const input = { email: 'bob@example.com' };
    r.redactValue(input);
    assert.equal(input.email, 'bob@example.com');
  });

  it('HMAC placeholders correlate the same value without revealing it', () => {
    const h = createRedactor({ hmacKey: 'test-key' });
    const a = h.redactString('bob@example.com');
    const b = h.redactString('again bob@example.com');
    const c = h.redactString('carol@example.com');
    assert.match(a, /^\[EMAIL:[0-9a-f]{6}\]$/);
    assert.ok(b.endsWith(a));
    assert.notEqual(a, c);
  });

  it('pino hooks redact both the merged object and the message string', () => {
    const opts = pinoRedactionOptions(r);
    assert.deepEqual(opts.formatters.log({ email: 'x@y.io' }), { email: '[EMAIL]' });
    let seen: unknown[] = [];
    opts.hooks.logMethod.call(null, [{ a: 1 }, 'login by x@y.io'], (...args) => (seen = args));
    assert.deepEqual(seen, [{ a: 1 }, 'login by [EMAIL]']);
  });
});
