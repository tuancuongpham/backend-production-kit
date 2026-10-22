import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Redis } from 'ioredis';
import { REDIS_URL, freshDatabase, runSqlFile } from '../support/infra.ts';
import { checkInventory, createDataLifecycle, type ExternalStore, type InventoryEntry } from '../../../skills/data-retention-and-erasure/references/erasure.ts';

let pool: pg.Pool;
let redis: Redis;
const ALICE = { id: 'u-1', email: 'alice@example.com', name: 'Alice Nguyen', phone: '0901234567' };

// Children first: entries run in order inside one transaction.
const inventory: InventoryEntry[] = [
  { table: 'chat_messages', subjectColumn: 'user_id', personal: ['content'], onErase: 'delete', retentionDays: 30, timeColumn: 'created_at' },
  { table: 'support_tickets', subjectColumn: 'user_id', personal: ['body'], onErase: 'delete' },
  {
    table: 'orders',
    subjectColumn: 'user_id',
    personal: ['customer_email', 'shipping_address'],
    onErase: 'anonymize',
    anonymize: { customer_email: "'erased'", shipping_address: 'NULL', user_id: 'NULL' },
    keepReason: 'invoices must be kept 10 years (accounting law)',
  },
  {
    table: 'audit_log',
    subjectColumn: 'actor_id',
    personal: ['ip_address'],
    onErase: 'anonymize',
    anonymize: { actor_id: "'erased'", ip_address: 'NULL' },
    keepReason: 'security audit trail',
  },
  { table: 'users', subjectColumn: 'id', personal: ['email', 'full_name', 'phone'], onErase: 'delete' },
];

/** Every text-like column of every table, searched for each needle: the proof that nothing is left. */
async function findAnywhere(needles: string[]) {
  const { rows: columns } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'inet')`,
  );
  const hits: string[] = [];
  for (const c of columns) {
    for (const needle of needles) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${c.table_name} WHERE ${c.column_name}::text ILIKE $1`, [`%${needle}%`]);
      if (rows[0].n > 0) hits.push(`${c.table_name}.${c.column_name} ∋ ${needle}`);
    }
  }
  return hits;
}

const redisStore: ExternalStore = {
  name: 'redis-cache',
  async erase(subjectId) {
    const keys: string[] = [];
    for (let cursor = '0'; ; ) {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `app:user:${subjectId}:*`, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
      if (cursor === '0') break;
    }
    if (keys.length) await redis.del(...keys);
  },
};

describe('data-retention-and-erasure', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_erasure'), max: 6 });
    redis = new Redis(REDIS_URL);
    await runSqlFile(pool, 'data-retention-and-erasure', 'erasure.sql');
    await pool.query(`
      CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL, full_name text, phone text);
      CREATE TABLE orders (id serial PRIMARY KEY, user_id text REFERENCES users(id), customer_email text, shipping_address text, total_vnd int NOT NULL);
      CREATE TABLE support_tickets (id serial PRIMARY KEY, user_id text REFERENCES users(id), body text NOT NULL);
      CREATE TABLE chat_messages (id serial PRIMARY KEY, user_id text REFERENCES users(id), content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE audit_log (id serial PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, ip_address inet, at timestamptz NOT NULL DEFAULT now());`);
  });
  after(async () => {
    await pool?.end();
    redis?.disconnect();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE erasure_requests, chat_messages, support_tickets, orders, audit_log, users RESTART IDENTITY`);
    for (const u of [ALICE, { id: 'u-2', email: 'bob@example.com', name: 'Bob Tran', phone: '0987654321' }]) {
      await pool.query(`INSERT INTO users VALUES ($1, $2, $3, $4)`, [u.id, u.email, u.name, u.phone]);
      await pool.query(`INSERT INTO orders (user_id, customer_email, shipping_address, total_vnd) VALUES ($1, $2, '12 Lý Thường Kiệt, Hà Nội', 250000), ($1, $2, '12 Lý Thường Kiệt, Hà Nội', 90000)`, [u.id, u.email]);
      await pool.query(`INSERT INTO support_tickets (user_id, body) VALUES ($1, $2)`, [u.id, `Hi, I am ${u.name}, call me at ${u.phone}`]);
      await pool.query(`INSERT INTO chat_messages (user_id, content) VALUES ($1, $2)`, [u.id, `my email is ${u.email}`]);
      await pool.query(`INSERT INTO audit_log (actor_id, action, ip_address) VALUES ($1, 'login', '203.0.113.7')`, [u.id]);
      await redis.set(`app:user:${u.id}:profile`, JSON.stringify(u));
      await redis.set(`app:user:${u.id}:session:abc`, 'token');
    }
  });

  it('erasing a user reaches every copy the inventory lists: afterwards no column anywhere holds their email, name or phone', async () => {
    const lifecycle = createDataLifecycle({ pool, inventory, stores: [redisStore], pepper: 'test-pepper' });
    const totalBefore = (await pool.query(`SELECT sum(total_vnd)::int AS s FROM orders`)).rows[0].s;
    const result = await lifecycle.requestErasure(ALICE.id);
    assert.deepEqual(result.rows, { chat_messages: 1, support_tickets: 1, orders: 2, audit_log: 1, users: 1 });
    assert.deepEqual(result.pendingStores, []);
    assert.deepEqual(await findAnywhere([ALICE.email, ALICE.name, ALICE.phone, ALICE.id]), []);
    assert.equal((await pool.query(`SELECT sum(total_vnd)::int AS s FROM orders`)).rows[0].s, totalBefore, 'invoice amounts are kept');
    assert.deepEqual(await redis.keys(`app:user:${ALICE.id}:*`), []);
    assert.equal((await redis.keys('app:user:u-2:*')).length, 2, "Bob's data is untouched");
    const request = (await pool.query(`SELECT subject_id, subject_hash IS NOT NULL AS proof, completed_at IS NOT NULL AS done FROM erasure_requests`)).rows[0];
    assert.deepEqual(request, { subject_id: null, proof: true, done: true });
  });

  it('a store that is down is retried until it is done; until then the request stays open', async () => {
    let failures = 2;
    const searchIndex: ExternalStore = {
      name: 'search-index',
      async erase() {
        if (failures-- > 0) throw new Error('search cluster unavailable');
      },
    };
    const lifecycle = createDataLifecycle({ pool, inventory, stores: [redisStore, searchIndex], pepper: 'test-pepper' });
    assert.deepEqual((await lifecycle.requestErasure(ALICE.id)).pendingStores, ['search-index']);
    const open = async () =>
      (await pool.query(`SELECT subject_id, stores -> 'search-index' ->> 'status' AS status, (stores -> 'search-index' ->> 'attempts')::int AS attempts, completed_at IS NOT NULL AS done FROM erasure_requests`)).rows[0];
    assert.deepEqual(await open(), { subject_id: ALICE.id, status: 'pending', attempts: 1, done: false });
    assert.deepEqual(await lifecycle.processPending(), { completed: 0, open: 1 });
    assert.deepEqual(await lifecycle.processPending(), { completed: 1, open: 0 });
    assert.deepEqual(await open(), { subject_id: null, status: 'done', attempts: 3, done: true });
  });

  it('erasure is all or nothing in the database: one failing table rolls back every other', async () => {
    // Valid at startup (every personal column is overwritten), but the expression fails when it runs.
    const broken: InventoryEntry[] = inventory.map((e) => (e.table === 'audit_log' ? { ...e, anonymize: { actor_id: 'no_such_column', ip_address: 'NULL' } } : e));
    const lifecycle = createDataLifecycle({ pool, inventory: broken, pepper: 'test-pepper' });
    await assert.rejects(lifecycle.requestErasure(ALICE.id), /no_such_column/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM chat_messages WHERE user_id = $1`, [ALICE.id])).rows[0].n, 1, 'nothing half-erased');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM erasure_requests`)).rows[0].n, 0);
  });

  it('an access request exports every inventoried row about the person', async () => {
    const lifecycle = createDataLifecycle({ pool, inventory, pepper: 'test-pepper' });
    const exported = await lifecycle.exportSubject('u-2');
    assert.deepEqual(Object.fromEntries(Object.entries(exported).map(([t, rows]) => [t, rows.length])), {
      chat_messages: 1,
      support_tickets: 1,
      orders: 2,
      audit_log: 1,
      users: 1,
    });
    assert.equal((exported.users[0] as { email: string }).email, 'bob@example.com');
  });

  it('retention deletes rows past their window in batches, only where the inventory sets one', async () => {
    await pool.query(`INSERT INTO chat_messages (user_id, content, created_at) SELECT 'u-2', 'old', now() - interval '90 days' FROM generate_series(1, 1200)`);
    const lifecycle = createDataLifecycle({ pool, inventory, pepper: 'test-pepper' });
    assert.deepEqual(await lifecycle.runRetention(500), { chat_messages: 1200 });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM chat_messages`)).rows[0].n, 2, 'recent messages stay');
  });

  it('the inventory audit flags personal-looking columns nobody has classified yet', async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS newsletter_signups (id serial PRIMARY KEY, email text, ho_ten text, so_dien_thoai text, source text)`);
    const lifecycle = createDataLifecycle({ pool, inventory, pepper: 'test-pepper' });
    assert.deepEqual(await lifecycle.auditInventory(), [
      { table: 'newsletter_signups', column: 'email' },
      { table: 'newsletter_signups', column: 'ho_ten' },
      { table: 'newsletter_signups', column: 'so_dien_thoai' },
    ]);
    assert.deepEqual(await lifecycle.auditInventory({ reviewed: ['newsletter_signups.email', 'newsletter_signups.ho_ten', 'newsletter_signups.so_dien_thoai'] }), []);
    await pool.query(`DROP TABLE newsletter_signups`);
  });

  it('an inventory that would leave personal data behind, or fail on every request, is refused at startup', () => {
    const unsafe: InventoryEntry[] = [
      // a kept order whose shipping address nobody overwrites
      { table: 'orders', subjectColumn: 'user_id', personal: ['shipping_address'], onErase: 'anonymize', anonymize: { user_id: 'NULL' } },
      // retention without the column to measure it by
      { table: 'chat_messages', subjectColumn: 'user_id', personal: ['content'], onErase: 'delete', retentionDays: 90 },
      // a name that would be SQL, not an identifier
      { table: 'users; DROP TABLE users', subjectColumn: 'id', personal: [], onErase: 'delete' },
    ];
    assert.deepEqual(checkInventory(unsafe), [
      'orders.shipping_address is kept as is on erasure: add it to anonymize',
      'chat_messages: retentionDays needs a positive whole number of days and a timeColumn',
      'users; DROP TABLE users: "users; DROP TABLE users" is not a plain identifier',
    ]);
    assert.throws(() => createDataLifecycle({ pool, inventory: unsafe, pepper: 'test-pepper' }), /unsafe inventory/);
  });
});
