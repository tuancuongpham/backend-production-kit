import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { sleep } from '../support/wait.ts';
import {
  downstreamKey,
  IdempotencyError,
  parseIdempotencyKey,
  pruneIdempotencyKeys,
  requestFingerprint,
  runIdempotent,
  runIdempotentExternal,
  type IdempotentRequest,
  type StoredResponse,
} from '../../../skills/idempotency-keys/references/idempotency.ts';

let pool: pg.Pool;
let calls = 0;

const SCOPE = 'tenant-a:user-1';
const req = (key: string, body: unknown = { item: 'book', qty: 1 }, scope = SCOPE, path = '/orders'): IdempotentRequest => ({
  scope,
  key,
  fingerprint: requestFingerprint('POST', path, body),
});

/** The business effect: one order row, written through the request's transaction. */
const createOrder =
  (workMs = 0) =>
  async (tx: pg.PoolClient): Promise<StoredResponse> => {
    calls++;
    const { rows } = await tx.query(`INSERT INTO orders (item) VALUES ('book') RETURNING id`);
    if (workMs) await sleep(workMs);
    return { status: 201, body: { orderId: Number(rows[0].id) }, headers: { location: `/orders/${rows[0].id}` } };
  };
const orders = async () => (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
const keyRows = async (key: string) => (await pool.query('SELECT status FROM idempotency_keys WHERE key = $1', [key])).rows;
const isStatus = (status: number) => (e: unknown) => e instanceof IdempotencyError && e.status === status;

describe('idempotency-keys', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_idempotency'), max: 25 });
    await runSqlFile(pool, 'idempotency-keys', 'idempotency.sql');
    await runSqlFile(pool, 'idempotency-keys', 'idempotency.sql'); // idempotent
    await pool.query(`CREATE TABLE orders (id bigserial PRIMARY KEY, item text NOT NULL)`);
  });
  after(async () => pool?.end());
  beforeEach(async () => {
    calls = 0;
    await pool.query('TRUNCATE idempotency_keys, orders');
  });

  it('the same key twice → one order, and the retry gets the identical response marked as a replay', async () => {
    const first = await runIdempotent(pool, req('k-1'), createOrder());
    const retry = await runIdempotent(pool, req('k-1'), createOrder());
    assert.equal(first.replayed, false);
    assert.equal(retry.replayed, true);
    assert.deepEqual([retry.status, retry.body, retry.headers], [first.status, first.body, first.headers]);
    assert.equal(calls, 1);
    assert.equal(await orders(), 1);
  });

  it('20 concurrent requests with one key → the handler runs once; the others get 409 at once, then the replay', async () => {
    await Promise.all(Array.from({ length: 20 }, () => pool.query('SELECT 1'))); // open the connections first
    const settled = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const t0 = performance.now();
        try {
          return { result: await runIdempotent(pool, req('k-burst'), createOrder(300)), ms: performance.now() - t0 };
        } catch (error) {
          return { error, ms: performance.now() - t0 };
        }
      }),
    );
    const executed = settled.filter((s) => s.result && !s.result.replayed);
    const conflicts = settled.filter((s) => s.error);
    assert.equal(calls, 1, 'the handler ran once');
    assert.equal(executed.length, 1);
    assert.ok(conflicts.length > 0);
    assert.ok(
      conflicts.every((s) => isStatus(409)(s.error) && s.ms < 200),
      `409s must not wait for the first request (300 ms): ${conflicts.map((s) => Math.round(s.ms)).join(', ')} ms`,
    );
    const retry = await runIdempotent(pool, req('k-burst'), createOrder());
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.body, executed[0].result!.body);
    assert.equal(await orders(), 1);
  });

  it('the same key for a different body or another endpoint → 422, and nothing runs', async () => {
    await runIdempotent(pool, req('k-reuse', { item: 'book' }), createOrder());
    await assert.rejects(runIdempotent(pool, req('k-reuse', { item: 'pen' }), createOrder()), isStatus(422));
    await assert.rejects(runIdempotent(pool, req('k-reuse', { item: 'book' }, SCOPE, '/refunds'), createOrder()), isStatus(422));
    assert.equal(calls, 1);
    assert.equal(await orders(), 1);
  });

  it('a handler that throws leaves no trace: the order rolls back, the key is free, and the retry runs once', async () => {
    await assert.rejects(
      runIdempotent(pool, req('k-fail'), async (tx) => {
        await createOrder()(tx);
        throw new Error('inventory service unavailable');
      }),
      /inventory service unavailable/,
    );
    assert.equal(await orders(), 0);
    assert.deepEqual(await keyRows('k-fail'), []);
    const retry = await runIdempotent(pool, req('k-fail'), createOrder());
    assert.equal(retry.replayed, false);
    assert.equal(await orders(), 1);
  });

  it('a crash right after the order insert (connection killed) leaves no order and no key; the retry runs once', async () => {
    await assert.rejects(
      runIdempotent(pool, req('k-crash'), async (tx) => {
        await createOrder()(tx);
        const { pid } = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0];
        await pool.query('SELECT pg_terminate_backend($1)', [pid]); // the app server dies right here
        await sleep(150);
        return { status: 201, body: {} };
      }),
    );
    assert.equal(await orders(), 0);
    assert.deepEqual(await keyRows('k-crash'), []);
    const retry = await runIdempotent(pool, req('k-crash'), createOrder());
    assert.equal(retry.replayed, false);
    assert.equal(await orders(), 1);
  });

  it('keys are scoped per caller: the same key from another tenant is another request', async () => {
    await runIdempotent(pool, req('k-shared', undefined, 'tenant-a:user-1'), createOrder());
    const other = await runIdempotent(pool, req('k-shared', undefined, 'tenant-b:user-9'), createOrder());
    assert.equal(other.replayed, false);
    assert.equal(await orders(), 2);
  });

  it('an expired key is a new request; pruning deletes expired keys in batches and keeps live ones', async () => {
    await runIdempotent(pool, req('k-old'), createOrder());
    await pool.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = 'k-old'`);
    const again = await runIdempotent(pool, req('k-old'), createOrder());
    assert.equal(again.replayed, false, 'a forgotten key runs again');
    assert.equal(await orders(), 2);

    await pool.query(
      `INSERT INTO idempotency_keys (scope, key, fingerprint, status, expires_at)
       SELECT 's', 'expired-' || g, 'f', 'done', now() - interval '1 hour' FROM generate_series(1, 2500) g`,
    );
    assert.equal(await pruneIdempotencyKeys(pool, 1000), 2500);
    assert.deepEqual((await pool.query('SELECT key FROM idempotency_keys')).rows.map((r) => r.key), ['k-old']);
  });

  describe('effects outside the database', () => {
    // A payment provider that dedups on the idempotency key it receives, as Stripe does.
    let charges: Map<string, string>;
    let providerCalls: number;
    const charge = async (key: string) => {
      providerCalls++;
      if (!charges.has(key)) charges.set(key, `ch_${charges.size + 1}`);
      return charges.get(key)!;
    };
    const pay =
      (workMs = 0) =>
      async ({ downstreamKey: key }: { downstreamKey: string }): Promise<StoredResponse> => {
        const chargeId = await charge(key);
        if (workMs) await sleep(workMs);
        return { status: 201, body: { chargeId } };
      };
    beforeEach(() => {
      charges = new Map();
      providerCalls = 0;
    });

    it('a duplicate during the provider call gets 409; afterwards the retry replays without calling the provider', async () => {
      const first = runIdempotentExternal(pool, req('k-pay'), pay(200));
      await sleep(50);
      await assert.rejects(runIdempotentExternal(pool, req('k-pay'), pay()), isStatus(409));
      const done = await first;
      const retry = await runIdempotentExternal(pool, req('k-pay'), pay());
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.body, done.body);
      assert.equal(providerCalls, 1);
    });

    it('a process that died after charging is recovered: past staleAfterSec a retry takes over and charges nothing new', async () => {
      const r = req('k-died');
      // The first attempt claimed the key and charged the card, then its process died before storing the response.
      await pool.query(
        `INSERT INTO idempotency_keys (scope, key, fingerprint, locked_at, expires_at)
         VALUES ($1, $2, $3, now() - interval '10 minutes', now() + interval '1 day')`,
        [r.scope, r.key, r.fingerprint],
      );
      await charge(downstreamKey(r));
      await assert.rejects(runIdempotentExternal(pool, r, pay(), { staleAfterSec: 3600 }), isStatus(409), 'not stale yet');
      await assert.rejects(runIdempotentExternal(pool, req('k-died', { item: 'other' }), pay()), isStatus(422), 'another request never takes it over');
      const recovered = await runIdempotentExternal(pool, r, pay(), { staleAfterSec: 60 });
      assert.equal(recovered.replayed, false);
      assert.deepEqual(recovered.body, { chargeId: 'ch_1' });
      assert.equal(charges.size, 1, 'the downstream key turned the second charge into a no-op');
      assert.equal((await runIdempotentExternal(pool, r, pay())).replayed, true);
    });

    it('a failed provider call releases the key, and the retry sends the same downstream key', async () => {
      const sent: string[] = [];
      await assert.rejects(
        runIdempotentExternal(pool, req('k-timeout'), async ({ downstreamKey: key }) => {
          sent.push(key);
          await charge(key); // it went through…
          throw new Error('provider timeout'); // …but the response was lost
        }),
        /provider timeout/,
      );
      assert.deepEqual(await keyRows('k-timeout'), []);
      const retry = await runIdempotentExternal(pool, req('k-timeout'), async (ctx) => {
        sent.push(ctx.downstreamKey);
        return pay()(ctx);
      });
      assert.equal(retry.replayed, false);
      assert.equal(sent[0], sent[1]);
      assert.equal(charges.size, 1);
    });
  });

  it('parses keys strictly and fingerprints requests canonically', () => {
    assert.equal(parseIdempotencyKey(undefined), undefined);
    assert.equal(parseIdempotencyKey('7f0c2a8e-4b1d-4e6a-9f3e-2d5c8b1a0e47'), '7f0c2a8e-4b1d-4e6a-9f3e-2d5c8b1a0e47');
    for (const bad of ['', 'a'.repeat(256), 'has space', 'k1, k2', 'khóa', ['a', 'b']]) {
      assert.throws(() => parseIdempotencyKey(bad), isStatus(400), JSON.stringify(bad));
    }
    const f = (body: unknown, path = '/orders') => requestFingerprint('POST', path, body);
    assert.equal(f({ a: 1, b: { c: [1, 2], d: 'x' } }), f({ b: { d: 'x', c: [1, 2] }, a: 1 }), 'key order does not matter');
    assert.equal(f({ a: 1, skipped: undefined }), f({ a: 1 }));
    assert.notEqual(f({ a: 1 }), f({ a: 2 }));
    assert.notEqual(f({ a: 1 }), f({ a: 1 }, '/refunds'));
    assert.notEqual(f([1, 2]), f([2, 1]), 'array order does');
    // A body built by the app: a Date is fingerprinted as the ISO string it sends.
    assert.equal(f({ at: new Date('2026-10-22T09:00:00Z') }), f({ at: '2026-10-22T09:00:00.000Z' }));
  });
});
