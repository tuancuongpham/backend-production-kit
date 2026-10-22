// shared/circuit-breaker.ts: closed → open after `threshold` failures → after `cooldownMs`, one probe → closed or open.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../../shared/circuit-breaker.ts';

function breaker(threshold = 3, cooldownMs = 1000) {
  const clock = { now: 0 };
  return { clock, b: new CircuitBreaker({ threshold, cooldownMs, now: () => clock.now }) };
}

describe('kernel: CircuitBreaker', () => {
  it('stays closed below the threshold, and a success resets the count', () => {
    const { b } = breaker(3);
    b.failure();
    b.failure();
    b.success();
    b.failure();
    b.failure();
    assert.deepEqual([b.state, b.tryAcquire()], ['closed', true]);
  });

  it('opens after `threshold` failures in a row, and refuses calls during the cooldown', () => {
    const { b, clock } = breaker(3, 1000);
    for (let i = 0; i < 3; i++) b.failure();
    clock.now = 999;
    assert.deepEqual([b.state, b.tryAcquire()], ['open', false]);
  });

  it('after the cooldown, lets exactly one probe out; its success closes the circuit', () => {
    const { b, clock } = breaker(3, 1000);
    for (let i = 0; i < 3; i++) b.failure();
    clock.now = 1000;
    assert.equal(b.state, 'half-open');
    assert.deepEqual([b.tryAcquire(), b.tryAcquire(), b.tryAcquire()], [true, false, false], 'one probe, not the whole backlog');
    b.success();
    assert.deepEqual([b.state, b.tryAcquire()], ['closed', true]);
  });

  it("a failed probe opens the circuit for another cooldown", () => {
    const { b, clock } = breaker(3, 1000);
    for (let i = 0; i < 3; i++) b.failure();
    clock.now = 1000;
    assert.equal(b.tryAcquire(), true);
    b.failure();
    clock.now = 1999;
    assert.deepEqual([b.state, b.tryAcquire()], ['open', false]);
    clock.now = 2000;
    assert.equal(b.tryAcquire(), true);
  });

  it('a probe that never reports gives up its slot after the cooldown', () => {
    const { b, clock } = breaker(1, 1000);
    b.failure();
    clock.now = 1000;
    assert.equal(b.tryAcquire(), true); // the probe hangs: no success(), no failure()
    clock.now = 1999;
    assert.equal(b.tryAcquire(), false);
    clock.now = 2000;
    assert.equal(b.tryAcquire(), true, 'another probe may go out');
  });

  it('refuses a configuration that could never work', () => {
    assert.throws(() => new CircuitBreaker({ threshold: 0, cooldownMs: 1000 }), RangeError);
    assert.throws(() => new CircuitBreaker({ threshold: 1.5, cooldownMs: 1000 }), RangeError);
    assert.throws(() => new CircuitBreaker({ threshold: 3, cooldownMs: -1 }), RangeError);
    assert.throws(() => new CircuitBreaker({ threshold: 3, cooldownMs: Number.NaN }), RangeError);
  });
});
