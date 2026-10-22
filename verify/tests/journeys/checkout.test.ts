// Journey: a shopper pays for her order. What her app and the network actually do to the order endpoint, end to end
// over real HTTP: a retry after a lost answer, a double tap, a tab closed mid-payment, a deploy mid-payment, keys the
// server can't accept, a bot. The shop is wired the way the skills say a real one is: hardened server → rate limit
// per user → Idempotency-Key → the order in Postgres → every log line through the redactor.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import pg from 'pg';
import { Redis } from 'ioredis';
import { freshDatabase, REDIS_URL, runSqlFile } from '../support/infra.ts';
import { waitFor } from '../support/wait.ts';
import { Gate } from '../support/gate.ts';
import { request, sendJson, type Reply } from '../support/http.ts';
import { createHardenedServer, readBody } from '../../../skills/service-hardening/references/server.ts';
import { IdempotencyError, IdempotencyKeys, parseIdempotencyKey, requestFingerprint } from '../../../skills/idempotency-keys/references/idempotency.ts';
import { createRateLimiter, rateLimitHeaders } from '../../../skills/rate-limiting/references/limiter.ts';
import { createRedactor } from '../../../skills/pii-redaction/references/redact.ts';

/** Checkouts per user before a 429: a burst of five, then one every ten seconds. */
const CHECKOUT_BURST = 5;

interface ShopOptions {
  /** Holds Lan's orders at the payment step until the test opens it. */
  payment?: Gate;
  /** On shutdown: how long the instance keeps answering while the load balancer notices. */
  drainMs?: number;
  /** On shutdown: how long in-flight requests may still finish. */
  graceMs?: number;
}

interface Shop {
  port: number;
  logs: string[];
  shutdown(): Promise<{ forced: boolean }>;
}

let pool: pg.Pool;
let redis: Redis;
let rateLimitPrefix: string;
const running: Shop[] = [];

/** One instance of the shop. Instances share the database and Redis, as behind a load balancer. */
async function startShop(o: ShopOptions = {}): Promise<Shop> {
  const logs: string[] = [];
  const redactor = createRedactor();
  const log = (msg: string, extra: Record<string, unknown> = {}) => void logs.push(JSON.stringify(redactor.redactValue({ msg, ...extra })));
  const limiter = createRateLimiter({ redis, capacity: CHECKOUT_BURST, refillPerSec: 0.1, failureMode: 'local', timeoutMs: 500, keyPrefix: rateLimitPrefix });
  const idempotency = new IdempotencyKeys({ pool });

  async function placeOrder(req: http.IncomingMessage, res: http.ServerResponse) {
    const userId = String(req.headers['x-user-id']); // stands in for authentication
    const limit = await limiter.check(`user:${userId}:checkout`);
    if (!limit.allowed) return sendJson(res, 429, { error: 'rate_limited' }, rateLimitHeaders(limit, CHECKOUT_BURST));
    const key = parseIdempotencyKey(req.headers['idempotency-key']);
    if (!key) return sendJson(res, 400, { error: 'idempotency_key_required' });
    const order = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
    const fingerprint = requestFingerprint('POST', '/v1/orders', order);
    const result = await idempotency.run({ scope: `shop:${userId}`, key, fingerprint }, async (tx) => {
      if (userId === LAN) await o.payment?.pass();
      const { rows } = await tx.query(`INSERT INTO orders (user_id, sku, qty, note) VALUES ($1, $2, $3, $4) RETURNING id`, [userId, order.sku, order.qty, order.note ?? null]);
      log('order created', { userId, order });
      return { status: 201, body: { orderId: Number(rows[0].id), note: order.note ?? null } };
    });
    sendJson(res, result.status, result.body, result.replayed ? { 'idempotent-replayed': 'true' } : {});
  }

  const app = createHardenedServer({
    drainDelayMs: o.drainMs ?? 20,
    shutdownGraceMs: o.graceMs ?? 2_000,
    log,
    handler: async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/orders') return sendJson(res, 404, { error: 'not_found' });
      try {
        await placeOrder(req, res);
      } catch (err) {
        if (err instanceof IdempotencyError) return sendJson(res, err.status, { error: err.code }, err.retryAfterSec ? { 'retry-after': String(err.retryAfterSec) } : {});
        if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'invalid_json' });
        throw err; // the server answers 413 for a body over the limit, 500 for anything else
      }
    },
  });
  const shop = { port: await app.listen(0, '127.0.0.1'), logs, shutdown: app.shutdown };
  running.push(shop);
  return shop;
}

/** What Lan's phone sends when she taps "Pay". */
const LAN = 'u-lan';
const BASKET = { sku: 'ao-dai-lua-01', qty: 1, note: 'Giao giờ hành chính 🙏 Gọi 0901 234 567 hoặc lan@shop.vn' };

function pay(shop: Shop, key: string | null, o: { user?: string; basket?: unknown; signal?: AbortSignal; headers?: Record<string, string | string[]> } = {}) {
  return request(shop.port, {
    method: 'POST',
    path: '/v1/orders',
    headers: { 'x-user-id': o.user ?? LAN, ...(key === null ? {} : { 'idempotency-key': key }), ...o.headers },
    body: o.basket ?? BASKET,
    signal: o.signal,
  });
}

const orders = async (user = LAN): Promise<number> => (await pool.query(`SELECT count(*)::int AS n FROM orders WHERE user_id = $1`, [user])).rows[0].n;
const replayOf = (r: Reply) => [r.status, r.headers['idempotent-replayed']];

describe('journey: a shopper pays for her order', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_journey_checkout'), max: 20 });
    await runSqlFile(pool, 'idempotency-keys', 'idempotency.sql');
    await pool.query(`CREATE TABLE orders (id bigserial PRIMARY KEY, user_id text NOT NULL, sku text NOT NULL, qty int NOT NULL CHECK (qty > 0), note text)`);
    redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();
  });
  after(async () => {
    await pool?.end();
    redis?.disconnect();
  });
  beforeEach(async () => {
    rateLimitPrefix = `rl-journey-${randomUUID()}`; // every test starts with full buckets
    await pool.query('TRUNCATE idempotency_keys, orders');
  });
  afterEach(async () => {
    await Promise.all(running.splice(0).map((shop) => shop.shutdown()));
  });

  it('Lan pays: one order, her note comes back intact, and no log line holds her phone number or email', async () => {
    const shop = await startShop();
    const reply = await pay(shop, randomUUID());
    assert.equal(reply.status, 201);
    assert.equal(reply.json().note, BASKET.note); // Vietnamese and emoji, through Postgres and back
    assert.equal(await orders(), 1);
    const logged = shop.logs.join('\n');
    assert.match(logged, /order created/);
    assert.ok(!logged.includes('0901 234 567') && !logged.includes('lan@shop.vn'), logged);
  });

  it('the answer is lost on the way back and her app retries: the same order comes back, marked as a replay', async () => {
    const shop = await startShop();
    const key = randomUUID();
    const first = await pay(shop, key);
    const retry = await pay(shop, key);
    assert.deepEqual(replayOf(retry), [201, 'true']);
    assert.deepEqual(retry.json(), first.json());
    assert.equal(await orders(), 1);
  });

  it('a double tap sends the order twice at once: one order; the second tap gets 409 with Retry-After, then the replay', async () => {
    const payment = new Gate();
    const shop = await startShop({ payment });
    const key = randomUUID();
    const firstTap = pay(shop, key);
    await payment.reached;
    const secondTap = await pay(shop, key);
    assert.deepEqual([secondTap.status, secondTap.headers['retry-after']], [409, '1']);
    payment.open();
    const first = await firstTap;
    assert.equal(first.status, 201);
    const afterRetryAfter = await pay(shop, key);
    assert.deepEqual(replayOf(afterRetryAfter), [201, 'true']);
    assert.deepEqual(afterRetryAfter.json(), first.json());
    assert.equal(await orders(), 1);
  });

  it('she closes the tab while the payment runs: the order still completes once, and reopening the page finds it', async () => {
    const payment = new Gate();
    const shop = await startShop({ payment });
    const key = randomUUID(); // her app keeps it with the unfinished checkout
    const tab = new AbortController();
    const closedTab = pay(shop, key, { signal: tab.signal }).catch((err: Error) => err);
    await payment.reached;
    tab.abort();
    assert.equal(((await closedTab) as Error).name, 'AbortError');
    payment.open();
    await waitFor(async () => (await orders()) === 1, 'the order to commit');
    assert.deepEqual(replayOf(await pay(shop, key)), [201, 'true']);
    assert.equal(await orders(), 1);
  });

  it('a deploy cuts her slow payment off: the retry reaches the new instance, waits, and never makes a second order', async () => {
    const payment = new Gate();
    const old = await startShop({ payment, drainMs: 300, graceMs: 100 });
    const next = await startShop();
    const key = randomUUID();
    const cutOff = pay(old, key).catch((err: Error) => err);
    await payment.reached;
    const deploy = old.shutdown();
    // Until the load balancer notices, the old instance still answers what it is sent (a 503 here is the deploy error
    // the drain exists to avoid), and closes each connection after its answer: Minh's next request opens a new one,
    // which goes to the new instance.
    const minh = await pay(old, randomUUID(), { user: 'u-minh' });
    assert.deepEqual([minh.status, minh.headers.connection], [201, 'close']);
    assert.ok((await cutOff) instanceof Error, 'the grace period ran out and closed her connection');
    // Her app retries on the new instance while the old one is still finishing her payment.
    const meanwhile = await pay(next, key);
    assert.deepEqual([meanwhile.status, meanwhile.headers['retry-after']], [409, '1']);
    payment.open();
    assert.deepEqual(await deploy, { forced: true });
    await waitFor(async () => (await orders()) === 1, 'the old instance to finish her order');
    assert.deepEqual(replayOf(await pay(next, key)), [201, 'true']);
    assert.equal(await orders(), 1);
  });

  it('her app reuses the key after she changed the basket: 422, and the first order stands', async () => {
    const shop = await startShop();
    const key = randomUUID();
    await pay(shop, key);
    const changed = await pay(shop, key, { basket: { ...BASKET, qty: 2 } });
    assert.deepEqual([changed.status, changed.json()], [422, { error: 'key_reused' }]);
    assert.equal(await orders(), 1);
  });

  it('keys the server can not accept are a 400 before anything runs: missing, too long, not ASCII, sent twice', async () => {
    const shop = await startShop();
    const vietnameseKey = Buffer.from('đơn-hàng-1', 'utf8').toString('latin1'); // the bytes a client puts on the wire
    const replies = [
      await pay(shop, null),
      await pay(shop, 'k'.repeat(256)),
      await pay(shop, vietnameseKey),
      await pay(shop, null, { headers: { 'idempotency-key': ['k-1', 'k-1'] } }),
    ];
    assert.deepEqual(
      replies.map((r) => [r.status, r.json().error]),
      [[400, 'idempotency_key_required'], [400, 'invalid_key'], [400, 'invalid_key'], [400, 'invalid_key']],
    );
    assert.equal(await orders(), 0);
  });

  it('a bot hammers checkout: past its burst it gets 429 with Retry-After, and Lan still pays', async () => {
    const shop = await startShop();
    const statuses: number[] = [];
    let last!: Reply;
    for (let i = 0; i < CHECKOUT_BURST + 3; i++) {
      last = await pay(shop, randomUUID(), { user: 'u-bot' });
      statuses.push(last.status);
    }
    assert.deepEqual(statuses, [...Array(CHECKOUT_BURST).fill(201), 429, 429, 429]);
    assert.equal(last.headers['ratelimit-remaining'], '0');
    assert.ok(Number(last.headers['retry-after']) >= 1, 'it is told when to come back');
    assert.equal((await pay(shop, randomUUID())).status, 201);
    assert.equal(await orders('u-bot'), CHECKOUT_BURST);
  });

  it('a body over the limit gets 413 and a broken one 400; the shop keeps serving', async () => {
    const shop = await startShop();
    const tooBig = await pay(shop, randomUUID(), { basket: { ...BASKET, note: 'x'.repeat(20_000) } });
    const broken = await request(shop.port, {
      method: 'POST',
      path: '/v1/orders',
      headers: { 'x-user-id': LAN, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      body: '{"sku": "ao-dai-lua-01", "qty": 1', // cut off
    });
    assert.deepEqual([tooBig.status, broken.status, broken.json()], [413, 400, { error: 'invalid_json' }]);
    assert.equal((await pay(shop, randomUUID())).status, 201);
    assert.equal(await orders(), 1);
  });
});
