import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { REDIS_URL, sleep } from './helpers.ts';
import { createRateLimiter, rateLimitHeaders } from '../../skills/rate-limiting/references/limiter.ts';

const opts = { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 200, lazyConnect: true };
const run = `t${Date.now()}`; // unique key space per test run
let clients: Redis[] = [];
let dead: Redis;

describe('rate-limiting', () => {
  before(async () => {
    clients = [new Redis(REDIS_URL, opts), new Redis(REDIS_URL, opts), new Redis(REDIS_URL, opts)];
    await Promise.all(clients.map((c) => c.connect()));
    // Nothing listens here: simulates Redis being down / partitioned away.
    dead = new Redis('redis://127.0.0.1:1', { ...opts, retryStrategy: () => null });
    dead.on('error', () => {});
  });
  after(async () => {
    clients.forEach((c) => c.disconnect());
    dead.disconnect();
  });

  it('allows a burst up to capacity, then 429 with Retry-After', async () => {
    const rl = createRateLimiter({ redis: clients[0], capacity: 5, refillPerSec: 1, failureMode: 'closed', keyPrefix: run });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await rl.check('tenant:a'));
    assert.deepEqual(results.map((r) => r.allowed), [true, true, true, true, true, false]);
    const denied = results[5];
    assert.equal(denied.source, 'redis');
    assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000);
    assert.equal(rateLimitHeaders(denied, 5)['Retry-After'], '1');
  });

  it('refills over time', async () => {
    const rl = createRateLimiter({ redis: clients[0], capacity: 2, refillPerSec: 10, failureMode: 'closed', keyPrefix: run });
    await rl.check('tenant:refill');
    await rl.check('tenant:refill');
    assert.equal((await rl.check('tenant:refill')).allowed, false);
    await sleep(150);
    assert.equal((await rl.check('tenant:refill')).allowed, true);
  });

  it('subjects are isolated and cost > 1 is honoured', async () => {
    const rl = createRateLimiter({ redis: clients[0], capacity: 10, refillPerSec: 0.001, failureMode: 'closed', keyPrefix: run });
    assert.equal((await rl.check('tenant:x', 8)).allowed, true);
    assert.equal((await rl.check('tenant:x', 8)).allowed, false);
    assert.equal((await rl.check('tenant:y', 8)).allowed, true);
  });

  it('is atomic across app instances: exactly capacity requests pass under concurrency', async () => {
    const limiters = clients.map((redis) =>
      createRateLimiter({ redis, capacity: 20, refillPerSec: 0.001, failureMode: 'closed', keyPrefix: run, timeoutMs: 500 }),
    );
    const checks = Array.from({ length: 90 }, (_, i) => limiters[i % 3].check('tenant:race'));
    const results = await Promise.all(checks);
    assert.equal(results.filter((r) => r.allowed).length, 20);
  });

  it('Redis down + fail-closed: rejects fast', async () => {
    const rl = createRateLimiter({ redis: dead, capacity: 5, refillPerSec: 1, failureMode: 'closed', timeoutMs: 50 });
    const t0 = performance.now();
    const r = await rl.check('tenant:a');
    assert.equal(r.allowed, false);
    assert.equal(r.source, 'fail-closed');
    assert.ok(performance.now() - t0 < 300, 'bounded latency');
  });

  it('slow Redis: times out to the fallback without an unhandled rejection later', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const slow = new Redis(REDIS_URL, { ...opts, commandTimeout: 300 });
    await slow.connect();
    const blocker = new Redis(REDIS_URL, opts);
    await blocker.connect();
    try {
      // Make the server busy so our EVAL sits in its queue: a 500ms busy-loop script blocks Redis
      // (DEBUG SLEEP is disabled by default in Redis 7).
      const spin = `local s = redis.call('TIME') local t0 = s[1] * 1000000 + s[2]
        while true do local n = redis.call('TIME') if n[1] * 1000000 + n[2] - t0 > 500000 then break end end
        return 1`;
      const busy = blocker.eval(spin, 0).catch(() => {});
      await sleep(20);
      const rl = createRateLimiter({ redis: slow, capacity: 5, refillPerSec: 1, failureMode: 'closed', timeoutMs: 50 });
      const r = await rl.check(`${run}:slow`);
      assert.equal(r.source, 'fail-closed');
      await busy;
      await sleep(400); // give the late rejection time to surface
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      slow.disconnect();
      blocker.disconnect();
    }
  });

  it('Redis down + fail-open: allows', async () => {
    const rl = createRateLimiter({ redis: dead, capacity: 5, refillPerSec: 1, failureMode: 'open' });
    assert.equal((await rl.check('tenant:a')).source, 'fail-open');
  });

  it('Redis down + local: still enforces a per-instance share of the limit', async () => {
    const rl = createRateLimiter({ redis: dead, capacity: 12, refillPerSec: 0.001, failureMode: 'local', instances: 3 });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await rl.check('tenant:a'));
    assert.deepEqual(results.map((r) => r.allowed), [true, true, true, true, false, false]); // 12 / 3 instances
    assert.ok(results.every((r) => r.source === 'local'));
  });

  it('circuit breaker stops calling a dead Redis after the threshold', async () => {
    const rl = createRateLimiter({ redis: dead, capacity: 5, refillPerSec: 1, failureMode: 'open', breakerThreshold: 3, breakerCooldownMs: 10_000 });
    for (let i = 0; i < 10; i++) await rl.check('tenant:a');
    assert.equal(rl.stats().redisCalls, 3);
    assert.equal(rl.stats().breakerOpen, true);
  });
});
