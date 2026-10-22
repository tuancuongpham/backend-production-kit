// Journey: a customer exercises her data rights (GDPR, Vietnam's Decree 13): she downloads what the shop holds about
// her, then deletes her account, tapping the button twice. Her profile sits in the Redis cache, and the search index
// that also holds her is down at that moment. Afterwards nothing answers with her data, and the invoices the law
// requires are kept without her name on them.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { freshDatabase, REDIS_URL, runSqlFile } from '../support/infra.ts';
import { request, sendJson } from '../support/http.ts';
import { createHardenedServer } from '../../../skills/service-hardening/references/server.ts';
import { createDataLifecycle, type ExternalStore, type InventoryEntry } from '../../../skills/data-retention-and-erasure/references/erasure.ts';
import { IdempotencyError, IdempotencyKeys, parseIdempotencyKey, requestFingerprint } from '../../../skills/idempotency-keys/references/idempotency.ts';
import { createCache } from '../../../skills/cache-stampede/references/cache.ts';

const inventory: InventoryEntry[] = [
  { table: 'support_tickets', subjectColumn: 'user_id', personal: ['body'], onErase: 'delete' },
  {
    table: 'orders',
    subjectColumn: 'user_id',
    personal: ['customer_email', 'shipping_address'],
    onErase: 'anonymize',
    anonymize: { customer_email: "'erased'", shipping_address: 'NULL', user_id: 'NULL' },
    keepReason: 'invoices are kept 10 years (accounting law)',
  },
  { table: 'users', subjectColumn: 'id', personal: ['email', 'full_name', 'phone'], onErase: 'delete' },
];

let pool: pg.Pool;
let redis: Redis;
let app: { port: number; shutdown(): Promise<unknown> };
const searchIndex = { down: false, erased: [] as string[] };

/** A customer with two orders and a ticket. Every value is her own, so finding it anywhere means it is hers. */
async function customer(name: string) {
  const tag = randomUUID().slice(0, 8);
  const phone = `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const c = { id: `u-${randomUUID()}`, email: `${name.toLowerCase()}.${tag}@shop.vn`, name: `Nguyễn Thị ${name} ${tag}`, phone };
  await pool.query(`INSERT INTO users (id, email, full_name, phone) VALUES ($1, $2, $3, $4)`, [c.id, c.email, c.name, c.phone]);
  for (const total of [250_000, 90_000]) {
    await pool.query(`INSERT INTO orders (user_id, customer_email, shipping_address, total_vnd) VALUES ($1, $2, '12 Lý Thường Kiệt, Hà Nội', $3)`, [c.id, c.email, total]);
  }
  await pool.query(`INSERT INTO support_tickets (user_id, body) VALUES ($1, $2)`, [c.id, `Tôi là ${c.name}, gọi ${c.phone}`]);
  return c;
}

async function startApp() {
  const cache = createCache({ redis, prefix: `journey-rights:${randomUUID()}`, ttlSec: 300 });
  const profileKey = (userId: string) => `user:${userId}:profile`;
  const stores: ExternalStore[] = [
    { name: 'profile-cache', erase: (userId) => cache.invalidate(profileKey(userId)) },
    {
      name: 'search-index',
      erase: async (userId) => {
        if (searchIndex.down) throw new Error('search index 503');
        searchIndex.erased.push(userId);
      },
    },
  ];
  const lifecycle = createDataLifecycle({ pool, inventory, stores, pepper: 'journey-pepper' });
  const idempotency = new IdempotencyKeys({ pool });

  const server = createHardenedServer({
    drainDelayMs: 0,
    handler: async (req, res) => {
      const userId = String(req.headers['x-user-id']); // from the authenticated session
      if (req.method === 'GET' && req.url === '/v1/me/profile') {
        const profile = await cache.get(profileKey(userId), async () => (await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId])).rows[0] ?? null);
        return profile ? sendJson(res, 200, profile) : sendJson(res, 404, { error: 'not_found' });
      }
      if (req.method === 'GET' && req.url === '/v1/me/data') return sendJson(res, 200, await lifecycle.exportSubject(userId));
      if (req.method === 'DELETE' && req.url === '/v1/me') {
        try {
          const key = parseIdempotencyKey(req.headers['idempotency-key']);
          if (!key) return sendJson(res, 400, { error: 'idempotency_key_required' });
          const r = await idempotency.runExternal({ scope: `user:${userId}`, key, fingerprint: requestFingerprint('DELETE', '/v1/me', null) }, async () => {
            const { requestId, pendingStores } = await lifecycle.requestErasure(userId);
            return { status: 202, body: { requestId, pendingStores } };
          });
          return sendJson(res, r.status, r.body, r.replayed ? { 'idempotent-replayed': 'true' } : {});
        } catch (err) {
          if (err instanceof IdempotencyError) return sendJson(res, err.status, { error: err.code });
          throw err;
        }
      }
      sendJson(res, 404, { error: 'not_found' });
    },
  });
  return { port: await server.listen(0, '127.0.0.1'), shutdown: server.shutdown, processPending: () => lifecycle.processPending() };
}

const as = (userId: string, method: string, path: string, headers: Record<string, string> = {}) =>
  request(app.port, { method, path, headers: { 'x-user-id': userId, ...headers } });

/** Every text-like column of every table, searched for each value: the proof that nothing is left. */
async function findAnywhere(values: string[]): Promise<string[]> {
  const { rows: columns } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb')`,
  );
  const hits: string[] = [];
  for (const c of columns) {
    for (const v of values) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${c.table_name} WHERE ${c.column_name}::text ILIKE $1`, [`%${v}%`]);
      if (rows[0].n > 0) hits.push(`${c.table_name}.${c.column_name}`);
    }
  }
  return hits;
}

describe('journey: a customer downloads her data, then deletes her account', () => {
  let started: Awaited<ReturnType<typeof startApp>>;
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_journey_rights'), max: 10 });
    await runSqlFile(pool, 'data-retention-and-erasure', 'erasure.sql');
    await runSqlFile(pool, 'idempotency-keys', 'idempotency.sql');
    await pool.query(`
      CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL, full_name text, phone text);
      CREATE TABLE orders (id serial PRIMARY KEY, user_id text REFERENCES users(id), customer_email text, shipping_address text, total_vnd int NOT NULL);
      CREATE TABLE support_tickets (id serial PRIMARY KEY, user_id text REFERENCES users(id), body text NOT NULL);`);
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    started = await startApp();
    app = started;
  });
  after(async () => {
    await app?.shutdown();
    redis?.disconnect();
    await pool?.end();
  });

  it('Lan downloads her data: every row about her, and nothing about anyone else', async () => {
    const lan = await customer('Lan');
    const bob = await customer('Bình');
    const data = (await as(lan.id, 'GET', '/v1/me/data')).json();
    assert.deepEqual([data.users.length, data.orders.length, data.support_tickets.length], [1, 2, 1]);
    assert.ok(!JSON.stringify(data).includes(bob.email));
  });

  it("she deletes her account, tapping twice at once: one erasure, and the app's retry gets the same answer", async () => {
    const lan = await customer('Lan');
    const key = randomUUID();
    const taps = await Promise.all([as(lan.id, 'DELETE', '/v1/me', { 'idempotency-key': key }), as(lan.id, 'DELETE', '/v1/me', { 'idempotency-key': key })]);
    assert.ok(taps.every((t) => [202, 409].includes(t.status)), taps.map((t) => t.status).join());
    const first = taps.find((t) => t.status === 202)!.json();
    const retry = await as(lan.id, 'DELETE', '/v1/me', { 'idempotency-key': key });
    assert.deepEqual([retry.status, retry.headers['idempotent-replayed'], retry.json().requestId], [202, 'true', first.requestId]);
    // Once erased, a request keeps only a hash of whose it was: count hers by it.
    const hash = createHash('sha256').update('journey-pepper').update(lan.id).digest('hex');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM erasure_requests WHERE subject_hash = $1`, [hash])).rows[0].n, 1);
  });

  it('afterwards nothing answers with her data, not even the cached profile; her invoices stay, without her', async () => {
    const lan = await customer('Lan');
    assert.equal((await as(lan.id, 'GET', '/v1/me/profile')).json().email, lan.email); // now cached in Redis
    const totals = async () => (await pool.query(`SELECT sum(total_vnd)::int AS s FROM orders`)).rows[0].s;
    const before = await totals();
    assert.equal((await as(lan.id, 'DELETE', '/v1/me', { 'idempotency-key': randomUUID() })).status, 202);
    assert.equal((await as(lan.id, 'GET', '/v1/me/profile')).status, 404, 'the cache was told, not left to expire');
    assert.deepEqual(await findAnywhere([lan.email, lan.name, lan.phone]), []);
    // Her id is left in one place on purpose: the deletion request's own idempotency key, so that a retried tap still
    // gets its answer. It expires with the key (24 h); the inventory lists it as operational data with that retention.
    assert.deepEqual(await findAnywhere([lan.id]), ['idempotency_keys.scope']);
    assert.equal(await totals(), before, 'invoice amounts are kept');
  });

  it('the search index is down while she deletes: the request stays open, and completes when the index is back', async () => {
    const lan = await customer('Lan');
    searchIndex.down = true;
    const reply = (await as(lan.id, 'DELETE', '/v1/me', { 'idempotency-key': randomUUID() })).json();
    assert.deepEqual(reply.pendingStores, ['search-index']);
    assert.deepEqual(await findAnywhere([lan.email]), [], 'the database part is done at once');
    searchIndex.down = false;
    const { completed } = await started.processPending();
    assert.ok(completed >= 1);
    assert.ok(searchIndex.erased.includes(lan.id));
  });
});
