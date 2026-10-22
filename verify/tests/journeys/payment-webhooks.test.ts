// Journey: the payment provider tells the shop that orders were paid. What providers and networks actually do to a
// webhook endpoint: deliver twice, deliver one event from several servers at once, deliver before the order is
// visible, deliver events out of order, send forged or captured requests, and sometimes never deliver at all. The
// shop: hardened server → signature check on the raw body → inbox → worker marks the order paid → dead letters →
// replay → reconciliation.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import { sleep } from '../support/wait.ts';
import { request, sendJson } from '../support/http.ts';
import { createHardenedServer, readBody } from '../../../skills/service-hardening/references/server.ts';
import {
  createInboxWorker,
  ingest,
  reconcile,
  replay,
  verifyTimestampedSignature,
  type Handler,
  type InboxRow,
  type Outcome,
} from '../../../skills/webhook-ingestion/references/webhooks.ts';

const SECRET = 'whsec_journey';

/** Signs the way the provider does (Stripe style): t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">. */
function signature(body: string, o: { at?: number; secrets?: string[] } = {}): string {
  const at = o.at ?? Math.floor(Date.now() / 1000);
  const v1 = (o.secrets ?? [SECRET]).map((secret) => `v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`);
  return [`t=${at}`, ...v1].join(',');
}

/** A provider event as the JSON text it sends: the signature covers these exact bytes. */
const paymentEvent = (id: string, type: string, orderId: number, amount: number) => JSON.stringify({ id, type, data: { orderId, amount } });

let pool: pg.Pool;
let endpoint: { port: number; shutdown(): Promise<unknown> };
let handlerRuns = 0;
const deadLetters: InboxRow[] = [];

const handlers: Record<string, Handler> = {
  'payments:payment.succeeded': async (row, tx) => {
    handlerRuns++;
    const { orderId, amount } = row.payload;
    const { rows } = await tx.query(`SELECT total, status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (rows.length === 0) throw new Error(`order ${orderId} is not there yet`); // the webhook beat the checkout's commit
    if (rows[0].status === 'paid') return;
    if (rows[0].total !== amount) throw new Error(`paid ${amount}, order total is ${rows[0].total}`); // for a human
    await tx.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [orderId]);
  },
  'payments:payment.failed': async (row, tx) => {
    // Events arrive out of order: a failure reported after the success must not undo it.
    await tx.query(`UPDATE orders SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [row.payload.orderId]);
  },
};

const worker = () => createInboxWorker({ pool, handlers, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, onDead: (row) => void deadLetters.push(row) });

/** Runs the worker until nothing is due, as its loop would (the backoffs here are milliseconds, not minutes). */
async function drain(): Promise<Outcome[]> {
  const w = worker();
  const outcomes: Outcome[] = [];
  for (let idle = 0; idle < 3; ) {
    const batch = await w.processOnce();
    outcomes.push(...batch);
    if (batch.length > 0) idle = 0;
    else {
      idle++;
      await sleep(10);
    }
  }
  return outcomes;
}

const deliver = (body: string, sig: string = signature(body)) =>
  request(endpoint.port, { method: 'POST', path: '/webhooks/payments', headers: { 'content-type': 'application/json', 'x-signature': sig }, body });

const placeOrder = async (total: number): Promise<number> => Number((await pool.query(`INSERT INTO orders (total) VALUES ($1) RETURNING id`, [total])).rows[0].id);
const statusOf = async (orderId: number): Promise<string> => (await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId])).rows[0]?.status;
const inboxSize = async (): Promise<number> => (await pool.query(`SELECT count(*)::int AS n FROM webhook_inbox`)).rows[0].n;

describe('journey: the payment provider reports payments', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_journey_webhooks'), max: 20 });
    await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
    await pool.query(`CREATE TABLE orders (id bigserial PRIMARY KEY, total int NOT NULL, status text NOT NULL DEFAULT 'pending')`);
    const app = createHardenedServer({
      drainDelayMs: 0,
      handler: async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/webhooks/payments') return sendJson(res, 404, { error: 'not_found' });
        const raw = await readBody(req, 64 * 1024); // the bytes as sent: re-serialized JSON would not match the signature
        const header = req.headers['x-signature'];
        if (!verifyTimestampedSignature({ secret: SECRET, rawBody: raw, header: typeof header === 'string' ? header : undefined })) {
          return sendJson(res, 400, { error: 'bad_signature' });
        }
        const event = JSON.parse(raw.toString('utf8'));
        const { inserted } = await ingest(pool, { provider: 'payments', eventId: event.id, eventType: event.type, payload: event.data });
        sendJson(res, 200, { received: true, duplicate: !inserted }); // fast: processing happens in the worker
      },
    });
    endpoint = { port: await app.listen(0, '127.0.0.1'), shutdown: app.shutdown };
  });
  after(async () => {
    await endpoint?.shutdown();
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE webhook_inbox, orders`);
    handlerRuns = 0;
    deadLetters.length = 0;
  });
  afterEach(async () => {
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM webhook_inbox WHERE status = 'processing'`)).rows[0].n, 0, 'no row left claimed');
  });

  it('the provider reports a payment: 200 at once, and the worker marks the order paid', async () => {
    const order = await placeOrder(250_000);
    const reply = await deliver(paymentEvent('evt_1', 'payment.succeeded', order, 250_000));
    assert.deepEqual([reply.status, reply.json()], [200, { received: true, duplicate: false }]);
    assert.equal(await statusOf(order), 'pending', 'acknowledged before processing: the provider is not kept waiting');
    assert.deepEqual(await drain(), ['done']);
    assert.equal(await statusOf(order), 'paid');
  });

  it('our 200 got lost and the provider delivers again, signed anew: acknowledged again, processed once', async () => {
    const order = await placeOrder(250_000);
    const body = paymentEvent('evt_2', 'payment.succeeded', order, 250_000);
    await deliver(body, signature(body, { at: Math.floor(Date.now() / 1000) - 60 }));
    assert.deepEqual(await drain(), ['done']);
    const again = await deliver(body);
    assert.deepEqual([again.status, again.json()], [200, { received: true, duplicate: true }]);
    assert.deepEqual(await drain(), []);
    assert.equal(handlerRuns, 1);
  });

  it('the provider retries from several servers at once: ten identical deliveries in parallel, one inbox row, one run', async () => {
    const order = await placeOrder(99_000);
    const body = paymentEvent('evt_3', 'payment.succeeded', order, 99_000);
    const replies = await Promise.all(Array.from({ length: 10 }, () => deliver(body)));
    assert.ok(replies.every((r) => r.status === 200));
    assert.equal(replies.filter((r) => !r.json().duplicate).length, 1);
    assert.deepEqual(await drain(), ['done']);
    assert.equal(handlerRuns, 1);
  });

  it('forged, tampered and wrongly signed requests get 400, and nothing is stored', async () => {
    const order = await placeOrder(250_000);
    const body = paymentEvent('evt_4', 'payment.succeeded', order, 250_000);
    const replies = [
      await deliver(body, ''), // no signature
      await deliver(body, 'v1=00ff'), // no timestamp
      await deliver(body.replace('250000', '1000'), signature(body)), // the amount changed after signing
      await deliver(body, signature(body, { secrets: ['whsec_guessed'] })),
      await deliver(JSON.stringify(JSON.parse(body), null, 2), signature(body)), // re-serialized on the way
    ];
    assert.deepEqual(
      replies.map((r) => r.status),
      [400, 400, 400, 400, 400],
    );
    assert.equal(await inboxSize(), 0);
  });

  it('a delivery captured on the network and sent again ten minutes later is refused', async () => {
    const order = await placeOrder(250_000);
    const body = paymentEvent('evt_5', 'payment.succeeded', order, 250_000);
    assert.equal((await deliver(body, signature(body, { at: Math.floor(Date.now() / 1000) - 600 }))).status, 400);
    assert.equal(await inboxSize(), 0);
  });

  it('during a secret rotation the provider signs with the old and the new secret: accepted', async () => {
    const order = await placeOrder(10_000);
    const body = paymentEvent('evt_6', 'payment.succeeded', order, 10_000);
    assert.equal((await deliver(body, signature(body, { secrets: ['whsec_retired', SECRET] }))).status, 200);
  });

  it('the payment arrives before the order is visible: retried with backoff, then paid', async () => {
    await deliver(paymentEvent('evt_7', 'payment.succeeded', 9001, 120_000)); // the order the checkout is about to commit
    assert.deepEqual(await worker().processOnce(), ['retry']);
    await pool.query(`INSERT INTO orders (id, total) VALUES (9001, 120000)`);
    assert.deepEqual(await drain(), ['done']);
    assert.equal(await statusOf(9001), 'paid');
  });

  it('events arrive out of order: a failure reported after the success does not undo the payment', async () => {
    const order = await placeOrder(50_000);
    await deliver(paymentEvent('evt_8a', 'payment.succeeded', order, 50_000));
    await deliver(paymentEvent('evt_8b', 'payment.failed', order, 50_000)); // an earlier attempt's failure, delivered late
    assert.deepEqual(await drain(), ['done', 'done']);
    assert.equal(await statusOf(order), 'paid');
  });

  it('an amount that does not match the order is dead-lettered for a human; after the fix, a replay pays the order', async () => {
    const order = await placeOrder(250_000);
    await deliver(paymentEvent('evt_9', 'payment.succeeded', order, 260_000)); // shipping was added at the provider
    assert.deepEqual(await drain(), ['retry', 'retry', 'dead']);
    assert.equal(deadLetters.length, 1, 'on-call is alerted once');
    const dead = (await pool.query(`SELECT id, last_error FROM webhook_dead_letters`)).rows;
    assert.deepEqual(dead.map((d) => d.last_error), ['paid 260000, order total is 250000']);
    assert.equal(await statusOf(order), 'pending');
    // On-call confirms the shipping fee with the provider, corrects the order, and replays the dead letter.
    await pool.query(`UPDATE orders SET total = 260000 WHERE id = $1`, [order]);
    assert.equal(await replay(pool, { ids: [dead[0].id] }), 1);
    assert.deepEqual(await drain(), ['done']);
    assert.equal(await statusOf(order), 'paid');
  });

  it('the provider never delivered one event: reconciliation finds it, and the order is paid', async () => {
    const delivered = await placeOrder(30_000);
    const missed = await placeOrder(75_000);
    await deliver(paymentEvent('evt_10', 'payment.succeeded', delivered, 30_000));
    // What the provider's API lists for the last day: the event we have, and one its outage swallowed.
    const listed = [
      { provider: 'payments', eventId: 'evt_10', eventType: 'payment.succeeded', payload: { orderId: delivered, amount: 30_000 } },
      { provider: 'payments', eventId: 'evt_11', eventType: 'payment.succeeded', payload: { orderId: missed, amount: 75_000 } },
    ];
    assert.deepEqual(await reconcile(pool, listed), { missed: 1 });
    assert.deepEqual(await drain(), ['done', 'done']);
    assert.deepEqual([await statusOf(delivered), await statusOf(missed)], ['paid', 'paid']);
  });

  it('an event type the shop does not handle is acknowledged and kept for audit, not retried forever', async () => {
    await deliver(JSON.stringify({ id: 'evt_12', type: 'payout.created', data: { amount: 1_000_000 } }));
    assert.deepEqual(await drain(), ['ignored']);
    const { rows } = await pool.query(`SELECT status, last_error FROM webhook_inbox WHERE event_id = 'evt_12'`);
    assert.deepEqual(rows, [{ status: 'done', last_error: 'ignored: no handler' }]);
  });
});
