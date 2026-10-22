import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../support/infra.ts';
import { sleep } from '../support/wait.ts';
import { createCache, tenantKey } from '../../../skills/cache-stampede/references/cache.ts';

const clients: Redis[] = [];
const redisClient = () => {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  clients.push(r);
  return r;
};
let run = 0;
const prefix = () => `cache-test:${Date.now()}:${run++}`;
/** An origin that counts its calls and takes `ms` to answer. */
const origin = (ms: number, value: (n: number) => unknown = (n) => ({ version: n })) => {
  const o = {
    calls: 0,
    load: async () => {
      const n = ++o.calls;
      await sleep(ms);
      return value(n);
    },
  };
  return o;
};

describe('cache-stampede', () => {
  let redis: Redis;
  before(() => {
    redis = redisClient();
  });
  after(() => {
    for (const c of clients) c.disconnect();
  });

  it('100 concurrent misses in one process → one origin call, and everyone gets the value', async () => {
    const cache = createCache({ redis, prefix: prefix(), ttlSec: 60 });
    const db = origin(50);
    const results = await Promise.all(Array.from({ length: 100 }, () => cache.get('product:42', db.load)));
    assert.equal(db.calls, 1);
    assert.ok(results.every((r) => JSON.stringify(r) === JSON.stringify({ version: 1 })));
  });

  it('three instances with 30 concurrent misses each → one origin call across all of them', async () => {
    const p = prefix();
    const instances = [1, 2, 3].map(() => createCache({ redis: redisClient(), prefix: p, ttlSec: 60 }));
    const db = origin(100);
    const results = await Promise.all(instances.flatMap((c) => Array.from({ length: 30 }, () => c.get('report:today', db.load))));
    assert.equal(db.calls, 1, 'the Redis lock collapses the misses of every instance');
    assert.equal(new Set(results.map((r) => JSON.stringify(r))).size, 1);
  });

  it('once stale, the old value is served at once while a single refresh runs, then the new one', async () => {
    const cache = createCache({ redis, prefix: prefix(), ttlSec: 0.2, staleSec: 5, jitter: 0 });
    const db = origin(200);
    assert.deepEqual(await cache.get('k', db.load), { version: 1 });
    await sleep(250); // stale now
    const t0 = performance.now();
    const stale = await Promise.all(Array.from({ length: 20 }, () => cache.get('k', db.load)));
    assert.ok(performance.now() - t0 < 100, 'nobody waited for the 200 ms refresh');
    assert.ok(stale.every((v) => JSON.stringify(v) === JSON.stringify({ version: 1 })));
    await sleep(300);
    assert.deepEqual(await cache.get('k', db.load), { version: 2 });
    assert.equal(db.calls, 2, 'one refresh, not twenty');
  });

  it('origin down: the stale value keeps being served until it expires for good, then the error surfaces', async () => {
    const errors: unknown[] = [];
    const cache = createCache({ redis, prefix: prefix(), ttlSec: 0.1, staleSec: 0.4, jitter: 0, onError: (e) => errors.push(e) });
    let down = false;
    const load = async () => {
      if (down) throw new Error('database unavailable');
      return { price: 100 };
    };
    await cache.get('price', load);
    down = true;
    await sleep(150);
    assert.deepEqual(await cache.get('price', load), { price: 100 }, 'stale, but served');
    await sleep(50);
    assert.ok(errors.some((e) => /database unavailable/.test(String(e))), 'the failed refresh was reported');
    await sleep(500);
    await assert.rejects(cache.get('price', load), /database unavailable/);
  });

  it('an instance that died holding the lock does not block the others: after waitMs they load it themselves', async () => {
    const p = prefix();
    await redis.set(`${p}:orphan:lock`, 'dead-instance', 'PX', 10_000);
    const cache = createCache({ redis, prefix: p, ttlSec: 60, waitMs: 200 });
    const db = origin(10);
    const t0 = performance.now();
    assert.deepEqual(await cache.get('orphan', db.load), { version: 1 });
    const waited = performance.now() - t0;
    assert.ok(waited >= 190 && waited < 1000, `waited ${Math.round(waited)} ms`);
  });

  it('Redis down: the cache steps aside, requests reach the origin, still one call per key per process', async () => {
    const dead = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on('error', () => {}); // the app's connection-level listener; the cache reports per call through onError
    clients.push(dead);
    const errors: unknown[] = [];
    const cache = createCache({ redis: dead, prefix: prefix(), ttlSec: 60, onError: (e) => errors.push(e) });
    const db = origin(30);
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.get('k', db.load)));
    assert.equal(db.calls, 1);
    assert.ok(results.every((r) => JSON.stringify(r) === JSON.stringify({ version: 1 })));
    assert.ok(errors.length > 0, 'the outage is reported');
  });

  it('jittered TTLs spread out keys written together, and missing rows are cached as null', async () => {
    const p = prefix();
    const cache = createCache({ redis, prefix: p, ttlSec: 10, staleSec: 0, jitter: 0.2 });
    for (let i = 0; i < 100; i++) await cache.get(`k${i}`, async () => i);
    const ttls = await Promise.all(Array.from({ length: 100 }, (_, i) => redis.pttl(`${p}:k${i}`)));
    assert.ok(Math.max(...ttls) - Math.min(...ttls) > 1000, `spread ${Math.max(...ttls) - Math.min(...ttls)} ms`);
    assert.ok(Math.min(...ttls) > 9000 && Math.max(...ttls) <= 12_000);
    const db = origin(1, () => null);
    assert.equal(await cache.get('user:404', db.load), null);
    assert.equal(await cache.get('user:404', db.load), null);
    assert.equal(db.calls, 1, 'a known miss does not reach the database again');
  });

  it('keys carry the tenant, so tenants never read each other’s entries', async () => {
    const cache = createCache({ redis, prefix: prefix(), ttlSec: 60 });
    const a = await cache.get(tenantKey('tenant-a', 'dashboard'), async () => 'A data');
    const b = await cache.get(tenantKey('tenant-b', 'dashboard'), async () => 'B data');
    assert.deepEqual([a, b], ['A data', 'B data']);
  });

  it('invalidate() after the data changed: the next read loads the new value, and other keys stay cached', async () => {
    const cache = createCache({ redis, prefix: prefix(), ttlSec: 60 });
    const db = origin(0);
    await cache.get('product:42', db.load);
    await cache.get('product:43', db.load);
    await cache.invalidate('product:42'); // the price changed, after the commit
    assert.deepEqual(await cache.get('product:42', db.load), { version: 3 });
    assert.deepEqual(await cache.get('product:43', db.load), { version: 2 });
    assert.equal(db.calls, 3);
  });

  it('an entry this cache did not write (an old format, another app) is a miss that gets overwritten, and is reported', async () => {
    const p = prefix();
    const errors: unknown[] = [];
    const cache = createCache({ redis, prefix: p, ttlSec: 60, onError: (e) => errors.push(e) });
    await redis.set(`${p}:legacy`, '{"written":"by v1, without a timestamp"}');
    assert.equal(await cache.get('legacy', async () => 'fresh'), 'fresh');
    assert.equal(await cache.get('legacy', async () => 'not called'), 'fresh');
    assert.match(String(errors[0]), /unreadable entry/);
  });
});
