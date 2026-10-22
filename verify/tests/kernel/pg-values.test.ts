// shared/pg-values.ts by example. The round trip through Postgres, over generated input, is in
// properties/formats.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pgJson, pgText } from '../../../shared/pg-values.ts';

describe('kernel: pgText and pgJson', () => {
  it('pgText replaces NUL and leaves everything else, strings or not, as it is', () => {
    assert.equal(pgText('Nguyễn\u0000Văn A'), 'Nguyễn�Văn A');
    assert.equal(pgText('no NUL 👍'), 'no NUL 👍');
    assert.equal(pgText(null), null);
    assert.equal(pgText(42), 42);
  });

  it('pgJson replaces NUL and half an emoji, in keys and values, and nothing that only looks like them', () => {
    const half = '😀'.slice(0, 1);
    assert.equal(pgJson({ 'k\u0000': `v${half}` }), '{"k\\ufffd":"v\\ufffd"}');
    assert.equal(pgJson({ text: 'a backslash then u0000: \\u0000' }), JSON.stringify({ text: 'a backslash then u0000: \\u0000' }));
    assert.equal(pgJson({ whole: '😀' }), '{"whole":"😀"}');
  });

  it('pgJson stores a BigInt as its decimal string, and undefined as null', () => {
    assert.equal(pgJson({ id: 9007199254740993n }), '{"id":"9007199254740993"}');
    assert.equal(pgJson(undefined), 'null');
  });
});
