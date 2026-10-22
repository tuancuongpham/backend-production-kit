// Each other skill promises a degradation: "fails fast", "falls back", "loses nothing". These tests put
// Toxiproxy between the reference code and the real Postgres and Redis, inject the network fault, and check
// the promise. Needs `npm run verify:up` (it starts Toxiproxy).
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
import { freshDatabase, runSqlFile, sleep, TOXI_PG_PORT, TOXI_REDIS_PORT, TOXIPROXY_URL, viaPort } from './helpers.ts';
import { createToxiproxy } from '../../skills/resilience-testing/references/toxiproxy.ts';
import { withTenant } from '../../skills/multitenant-postgres/references/tenant-db.ts';
import { createRateLimiter } from '../../skills/rate-limiting/references/limiter.ts';
import { createCache } from '../../skills/cache-stampede/references/cache.ts';
import { createRelay, enqueue } from '../../skills/outbox-pattern/references/outbox.ts';

const toxi = createToxiproxy(TOXIPROXY_URL);
let dbUrl: string;
let proxiedUrl: string;
let pgProxy: Awaited<ReturnType<typeof toxi.proxy>>;
let redisProxy: Awaited<ReturnType<typeof toxi.proxy>>;
const closers: Array<() => Promise<unknown> | void> = [];
/**
 * With enableOfflineQueue: false (what rate-limiting recommends), commands sent before the connection is ready
 * fail at once. Connect first, as an app should before it reports ready.
 */
const redisVia = async () => {
  const r = new Redis({ host: 'localhost', port: TOXI_REDIS_PORT, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy: () => 100 });
  r.on('error', () => {}); // connection-level errors: the code under test reports per call
  closers.push(() => r.disconnect());
  await r.connect();
  return r;
};
const time = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

describe('resilience-testing', () => {
  before(async () => {
    assert.ok(await toxi.available(), `Toxiproxy is not reachable at ${TOXIPROXY_URL}: run npm run verify:up`);
    dbUrl = await freshDatabase('kit_resilience');
    proxiedUrl = viaPort(dbUrl, TOXI_PG_PORT);
    pgProxy = await toxi.proxy('kit_postgres', `0.0.0.0:${TOXI_PG_PORT}`, 'postgres:5432');
    redisProxy = await toxi.proxy('kit_redis', `0.0.0.0:${TOXI_REDIS_PORT}`, 'redis:6379');
    const admin = new pg.Pool({ connectionString: dbUrl, max: 1 });
    await runSqlFile(admin, 'outbox-pattern', 'outbox.sql');
    await admin.end();
  });
  afterEach(async () => {
    await toxi.reset();
    while (closers.length) await closers.pop()!();
  });
  after(async () => toxi.reset());

  it('a slow network: server-side statement_timeout does not help, a client-side query_timeout does', async () => {
    const serverTimeout = new pg.Pool({ connectionString: proxiedUrl, max: 1, options: '-c statement_timeout=300' });
    const clientTimeout = new pg.Pool({ connectionString: proxiedUrl, max: 1, query_timeout: 300 });
    closers.push(() => serverTimeout.end(), () => clientTimeout.end());
    await serverTimeout.query('SELECT 1');
    await clientTimeout.query('SELECT 1'); // connected before the network degrades
    await pgProxy.with({ type: 'latency', attributes: { latency: 1000 } }, async () => {
      const slow = await time(() => serverTimeout.query('SELECT 1'));
      const fast = await time(() => assert.rejects(clientTimeout.query('SELECT 1'), /timeout/i));
      assert.ok(slow >= 900, `the query itself is instant, so statement_timeout never fires: ${Math.round(slow)} ms`);
      assert.ok(fast < 600, `query_timeout gave up after ${Math.round(fast)} ms`);
    });
  });

  it('a black-holed database: a new connection without connectionTimeoutMillis waits forever; with it, it fails in 500 ms', async () => {
    const hole = await pgProxy.add({ type: 'timeout', attributes: { timeout: 0 } });
    const patient = new pg.Client({ connectionString: proxiedUrl });
    patient.on('error', () => {});
    const connecting = patient.connect().then(
      () => 'connected',
      (e: Error) => `failed: ${e.message}`,
    );
    const bounded = new pg.Pool({ connectionString: proxiedUrl, connectionTimeoutMillis: 500 });
    closers.push(() => bounded.end());
    const failedAfter = await time(() => assert.rejects(bounded.connect(), /timeout/i));
    assert.ok(failedAfter < 1000, `bounded connect failed after ${Math.round(failedAfter)} ms`);
    assert.equal(await Promise.race([connecting, sleep(2000).then(() => 'still waiting')]), 'still waiting');
    await pgProxy.remove(hole);
    await pgProxy.down(); // drop the stuck connection
    await connecting;
    await patient.end().catch(() => {});
  });

  it('the connection is reset in the middle of a transaction: that request fails, the process keeps serving', async () => {
    const pool = new pg.Pool({ connectionString: proxiedUrl, max: 2 });
    pool.on('error', () => {});
    closers.push(() => pool.end());
    await assert.rejects(
      withTenant(pool, '44444444-4444-4444-8444-444444444444', async (c) => {
        await c.query('SELECT 1');
        await pgProxy.add({ type: 'reset_peer', attributes: { timeout: 0 } });
        await c.query('SELECT 2'); // reset on the wire
      }),
    );
    await toxi.reset();
    assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'a fresh connection works');
  });

  it('Redis slower than the limiter timeout: decisions fall back in time, and return to Redis once it recovers', async () => {
    const rl = createRateLimiter({
      redis: await redisVia(),
      capacity: 100,
      refillPerSec: 10,
      failureMode: 'local',
      timeoutMs: 50,
      breakerThreshold: 3,
      keyPrefix: `resilience-${Date.now()}`,
    });
    assert.equal((await rl.check('tenant:1')).source, 'redis');
    await redisProxy.with({ type: 'latency', attributes: { latency: 300 } }, async () => {
      let source = '';
      const took = await time(async () => {
        source = (await rl.check('tenant:1')).source;
      });
      assert.equal(source, 'local');
      assert.ok(took < 150, `fell back after ${Math.round(took)} ms, not after Redis's 300 ms`);
    });
    await sleep(400); // late replies drain
    assert.equal((await rl.check('tenant:1')).source, 'redis');
  });

  it('Redis goes down: the cache steps aside and reports it, requests are served from the origin', async () => {
    const errors: unknown[] = [];
    const cache = createCache({ redis: await redisVia(), prefix: `resilience-${Date.now()}`, ttlSec: 60, onError: (e) => errors.push(e) });
    assert.equal(await cache.get('k', async () => 'from the database'), 'from the database');
    assert.equal(await cache.get('k', async () => 'not called'), 'from the database', 'cached while Redis is up');
    assert.deepEqual(errors, []);
    await redisProxy.down();
    let calls = 0;
    const value = await cache.get('other', async () => {
      calls++;
      return 'still served';
    });
    assert.equal(value, 'still served');
    assert.equal(calls, 1);
    assert.ok(errors.length > 0, 'the outage is reported');
  });

  it('Postgres disappears during an outbox relay: nothing is lost, the batch goes out again after recovery', async () => {
    const admin = new pg.Pool({ connectionString: dbUrl, max: 1 });
    closers.push(() => admin.end());
    const tx = await admin.connect();
    await tx.query('BEGIN');
    for (let i = 1; i <= 3; i++) await enqueue(tx, { aggregateType: 'order', aggregateId: `o-${i}`, eventType: 'order.placed', payload: { i } });
    await tx.query('COMMIT');
    tx.release();

    const pool = new pg.Pool({ connectionString: proxiedUrl, max: 2, connectionTimeoutMillis: 1000 });
    pool.on('error', () => {});
    closers.push(() => pool.end());
    const sent: string[] = [];
    let cut = true;
    const relay = createRelay({
      pool,
      publish: async (m) => {
        sent.push(m.id);
        if (cut) {
          cut = false;
          await pgProxy.down(); // the database goes away after the first publish
        }
      },
    });
    await assert.rejects(relay.relayOnce());
    await pgProxy.up();
    assert.equal(await relay.relayOnce(), 3);
    assert.equal(new Set(sent).size, 3, 'every message was published');
    assert.equal(sent.length, 4, 'the relay stopped when its connection died: only the first went out twice (consumers dedup by id)');
  });
});
