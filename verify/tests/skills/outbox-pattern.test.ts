import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { waitFor } from '../support/wait.ts';
import { consumeOnce, createRelay, enqueue, type OutboxMessage } from '../../../skills/outbox-pattern/references/outbox.ts';

let pool: pg.Pool;

async function placeOrder(id: string, fail = false) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO orders (id, status) VALUES ($1, 'placed')`, [id]);
    await enqueue(c, { aggregateType: 'order', aggregateId: id, eventType: 'order.placed', payload: { id } });
    if (fail) throw new Error('payment validation failed');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('outbox-pattern', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_outbox'), max: 10 });
    await runSqlFile(pool, 'outbox-pattern', 'outbox.sql');
    await pool.query(`CREATE TABLE orders (id text PRIMARY KEY, status text);
                      CREATE TABLE emails_sent (order_id text);`);
  });
  after(async () => pool?.end());
  beforeEach(async () => pool.query('TRUNCATE outbox, processed_messages, orders, emails_sent'));

  it('event exists iff the business transaction commits', async () => {
    await assert.rejects(placeOrder('o1', true));
    assert.equal((await pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n, 0);
    await placeOrder('o2');
    assert.equal((await pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n, 1);
  });

  it('relay publishes each message once and marks it', async () => {
    await placeOrder('o1');
    const sent: OutboxMessage[] = [];
    const relay = createRelay({ pool, publish: async (m) => void sent.push(m) });
    assert.equal(await relay.relayOnce(), 1);
    assert.equal(await relay.relayOnce(), 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event_type, 'order.placed');
  });

  it('broker outage: message stays pending and order is preserved on recovery', async () => {
    for (const id of ['o1', 'o2', 'o3']) await placeOrder(id);
    const sent: string[] = [];
    let failOn: string | null = 'o2';
    const relay = createRelay({
      pool,
      publish: async (m) => {
        if (m.aggregate_id === failOn) throw new Error('broker unavailable');
        sent.push(m.aggregate_id);
      },
    });
    assert.equal(await relay.relayOnce(), 1); // o1 ok, o2 fails, o3 must NOT overtake
    assert.deepEqual(sent, ['o1']);
    const o2 = (await pool.query(`SELECT attempts, last_error FROM outbox WHERE aggregate_id = 'o2'`)).rows[0];
    assert.deepEqual(o2, { attempts: 1, last_error: 'broker unavailable' });
    failOn = null;
    assert.equal(await relay.relayOnce(), 2);
    assert.deepEqual(sent, ['o1', 'o2', 'o3']);
  });

  it('crash after publish but before marking → redelivery → consumer applies once', async () => {
    await placeOrder('o1');
    const broker: OutboxMessage[] = [];
    let crash = true;
    const relay = createRelay({
      pool,
      publish: async (m) => {
        broker.push(m); // the broker got it...
        if (crash) throw new Error('connection reset before ack'); // ...but the relay thinks it failed
      },
    });
    await relay.relayOnce();
    crash = false;
    await relay.relayOnce();
    assert.equal(broker.length, 2, 'at-least-once delivery produced a duplicate');

    const results = [];
    for (const m of broker) {
      results.push(
        await consumeOnce(pool, 'email-service', m.id, (tx) => tx.query(`INSERT INTO emails_sent VALUES ($1)`, [m.aggregate_id]).then(() => {})),
      );
    }
    assert.deepEqual(results, ['applied', 'duplicate']);
    assert.equal((await pool.query('SELECT count(*)::int n FROM emails_sent')).rows[0].n, 1);
  });

  it('consumer failure rolls back the dedup mark so the message can be retried', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    await assert.rejects(consumeOnce(pool, 'svc', id, async () => { throw new Error('boom'); }));
    assert.equal(await consumeOnce(pool, 'svc', id, async () => {}), 'applied');
  });

  it('competing relays: only one is active, nothing is published twice', async () => {
    for (let i = 0; i < 20; i++) await placeOrder(`o${i}`);
    const sent: string[] = [];
    const slowPublish = async (m: OutboxMessage) => {
      await new Promise((r) => setTimeout(r, 5));
      sent.push(m.id);
    };
    const relays = [createRelay({ pool, publish: slowPublish }), createRelay({ pool, publish: slowPublish })];
    const counts = await Promise.all(relays.map((r) => r.relayOnce()));
    assert.equal(counts.filter((c) => c === 0).length, 1, 'second relay backed off');
    assert.equal(new Set(sent).size, sent.length);
    assert.equal(sent.length, 20);
  });

  it('run(): drains a backlog bigger than one batch, then follows new messages until stopped', async () => {
    for (let i = 0; i < 25; i++) await placeOrder(`o${i}`);
    const sent: string[] = [];
    const ac = new AbortController();
    const running = createRelay({ pool, publish: async (m) => void sent.push(m.id), batchSize: 10 }).run({ signal: ac.signal, idleMs: 20 });
    await waitFor(() => sent.length >= 25, 'the backlog');
    await placeOrder('late');
    await waitFor(() => sent.length >= 26, 'the late message');
    ac.abort();
    await running;
    assert.equal(sent.length, 26);
    assert.equal(new Set(sent).size, 26, 'each message once');
    assert.equal((await pool.query('SELECT count(*)::int n FROM outbox WHERE published_at IS NULL')).rows[0].n, 0);
  });
});
