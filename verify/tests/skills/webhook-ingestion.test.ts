import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../support/infra.ts';
import {
  backoffMs,
  createInboxWorker,
  ingest,
  reconcile,
  replay,
  verifyHmacHex,
  verifyTimestampedSignature,
  type Handler,
} from '../../../skills/webhook-ingestion/references/webhooks.ts';

let pool: pg.Pool;

const evt = (id: string, type = 'payment.succeeded', amount = 100) => ({
  provider: 'stripe',
  eventId: id,
  eventType: type,
  payload: { id, amount },
});

// Business side effect lives in the same DB: credited payments, unique per event.
const creditHandler: Handler = async (row, tx) => {
  await tx.query(`INSERT INTO credits (event_id, amount) VALUES ($1, $2)`, [row.event_id, row.payload.amount]);
};

async function makeAllDue() {
  await pool.query(`UPDATE webhook_inbox SET next_attempt_at = now() WHERE status = 'pending'`);
}

describe('webhook-ingestion', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_webhooks'), max: 10 });
    await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
    await pool.query(`CREATE TABLE credits (event_id text PRIMARY KEY, amount int NOT NULL)`);
  });
  after(async () => pool?.end());
  beforeEach(async () => pool.query(`TRUNCATE webhook_inbox, credits`));

  describe('signatures', () => {
    const secret = 'whsec_test';
    const body = '{"id":"evt_1","amount":100}';
    const t = 1_760_000_000;
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

    it('accepts a valid timestamped signature', () => {
      assert.equal(verifyTimestampedSignature({ secret, rawBody: body, header: `t=${t},v1=${sig}`, nowSec: t + 10 }), true);
    });
    it('rejects tampered body, wrong secret, stale timestamp, malformed header', () => {
      assert.equal(verifyTimestampedSignature({ secret, rawBody: body.replace('100', '999'), header: `t=${t},v1=${sig}`, nowSec: t }), false);
      assert.equal(verifyTimestampedSignature({ secret: 'other', rawBody: body, header: `t=${t},v1=${sig}`, nowSec: t }), false);
      assert.equal(verifyTimestampedSignature({ secret, rawBody: body, header: `t=${t},v1=${sig}`, nowSec: t + 3600 }), false);
      assert.equal(verifyTimestampedSignature({ secret, rawBody: body, header: 'garbage', nowSec: t }), false);
      assert.equal(verifyTimestampedSignature({ secret, rawBody: body, header: undefined, nowSec: t }), false);
    });
    it('verifies plain HMAC (VNPay sha512 style) and rejects wrong length', () => {
      const data = 'vnp_Amount=1000000&vnp_TxnRef=123';
      const good = createHmac('sha512', 'vnp-secret').update(data).digest('hex');
      assert.equal(verifyHmacHex('vnp-secret', data, good.toUpperCase(), 'sha512'), true);
      assert.equal(verifyHmacHex('vnp-secret', data, good.slice(0, 10), 'sha512'), false);
    });
  });

  it('duplicate deliveries are stored once and processed once', async () => {
    assert.equal((await ingest(pool, evt('evt_1'))).inserted, true);
    assert.equal((await ingest(pool, evt('evt_1'))).inserted, false);
    const worker = createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': creditHandler } });
    assert.deepEqual(await worker.processOnce(), ['done']);
    await ingest(pool, evt('evt_1')); // provider retries after we already processed
    assert.deepEqual(await worker.processOnce(), []);
    assert.equal((await pool.query('SELECT count(*)::int n FROM credits')).rows[0].n, 1);
  });

  it('failures roll back side effects, back off, then succeed on retry', async () => {
    await ingest(pool, evt('evt_2'));
    let calls = 0;
    const flaky: Handler = async (row, tx) => {
      calls++;
      await creditHandler(row, tx); // side effect happens...
      if (calls < 3) throw new Error('downstream 503'); // ...then failure → must be rolled back
    };
    const worker = createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': flaky }, random: () => 0.5 });

    assert.deepEqual(await worker.processOnce(), ['retry']);
    const row = (await pool.query(`SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM webhook_inbox`)).rows[0];
    assert.deepEqual([row.status, row.attempts, row.last_error, row.later], ['pending', 1, 'downstream 503', true]);
    assert.equal((await pool.query('SELECT count(*)::int n FROM credits')).rows[0].n, 0, 'side effect rolled back');
    assert.deepEqual(await worker.processOnce(), [], 'not due yet');

    await makeAllDue();
    assert.deepEqual(await worker.processOnce(), ['retry']);
    await makeAllDue();
    assert.deepEqual(await worker.processOnce(), ['done']);
    assert.equal((await pool.query('SELECT count(*)::int n FROM credits')).rows[0].n, 1);
  });

  it('exhausted retries go to the dead-letter queue, then replay recovers them', async () => {
    await ingest(pool, evt('evt_3'));
    const dead: string[] = [];
    let broken = true;
    const handler: Handler = async (row, tx) => {
      if (broken) throw new Error('bug in handler');
      await creditHandler(row, tx);
    };
    const worker = createInboxWorker({
      pool,
      handlers: { 'stripe:payment.succeeded': handler },
      maxAttempts: 2,
      onDead: (r) => dead.push(r.event_id),
    });
    await worker.processOnce();
    await makeAllDue();
    assert.deepEqual(await worker.processOnce(), ['dead']);
    assert.deepEqual(dead, ['evt_3']);
    assert.equal((await pool.query('SELECT count(*)::int n FROM webhook_dead_letters')).rows[0].n, 1);

    broken = false; // bug fixed and deployed
    assert.equal(await replay(pool, { provider: 'stripe' }), 1);
    assert.deepEqual(await worker.processOnce(), ['done']);
    assert.equal((await pool.query('SELECT count(*)::int n FROM credits')).rows[0].n, 1);
  });

  it('concurrent workers never process the same event twice (SKIP LOCKED)', async () => {
    for (let i = 0; i < 60; i++) await ingest(pool, evt(`evt_c${i}`));
    const workers = Array.from({ length: 4 }, () =>
      createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': creditHandler }, batchSize: 5 }),
    );
    const drain = async (w: ReturnType<typeof createInboxWorker>) => {
      while ((await w.processOnce()).length > 0);
    };
    await Promise.all(workers.map(drain));
    const { rows } = await pool.query(`SELECT count(*)::int n, count(DISTINCT event_id)::int d FROM credits`);
    assert.deepEqual(rows[0], { n: 60, d: 60 }); // a double-process would have hit the PK and gone to retry
    assert.equal((await pool.query(`SELECT count(*)::int n FROM webhook_inbox WHERE status <> 'done'`)).rows[0].n, 0);
  });

  it("a claimed event whose lease passed to another worker before its turn in the batch isn't run by this one", async () => {
    await ingest(pool, evt('evt_q1'));
    await ingest(pool, evt('evt_q2'));
    const ran: string[] = [];
    const worker = createInboxWorker({
      pool,
      batchSize: 2,
      handlers: {
        'stripe:payment.succeeded': async (row, tx) => {
          ran.push(row.event_id);
          // While this one runs, another worker takes the other over (as stuck, with a lease of its own).
          await pool.query(`UPDATE webhook_inbox SET lease_id = gen_random_uuid() WHERE event_id <> $1`, [row.event_id]);
          await creditHandler(row, tx);
        },
      },
    });
    assert.deepEqual((await worker.processOnce()).sort(), ['done', 'lost']);
    assert.equal(ran.length, 1, 'the handler ran for the event this worker still owned, only');
  });

  it('rows stuck in processing after a crash are re-claimed', async () => {
    await ingest(pool, evt('evt_4'));
    await pool.query(`UPDATE webhook_inbox SET status = 'processing', attempts = 1, locked_at = now() - interval '1 hour'`);
    const worker = createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': creditHandler } });
    assert.deepEqual(await worker.processOnce(), ['done']);
  });

  it('one claim takes stuck rows first, then due rows, up to batchSize in total', async () => {
    for (const id of ['evt_s', 'evt_p1', 'evt_p2', 'evt_p3']) await ingest(pool, evt(id));
    await pool.query(`UPDATE webhook_inbox SET status = 'processing', attempts = 1, locked_at = now() - interval '1 hour' WHERE event_id = 'evt_s'`);
    const worker = createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': creditHandler }, batchSize: 3 });
    assert.deepEqual(await worker.processOnce(), ['done', 'done', 'done']);
    const { rows } = await pool.query(`SELECT event_id, status FROM webhook_inbox ORDER BY event_id`);
    assert.equal(rows.find((r) => r.event_id === 'evt_s').status, 'done');
    assert.equal(rows.filter((r) => r.status === 'pending').length, 1);
  });

  it('run(): independent loops drain the inbox, and stopping waits for the rows they claimed', async () => {
    for (let i = 0; i < 12; i++) await ingest(pool, evt(`evt_r${i}`));
    let active = 0;
    let maxActive = 0;
    const slowCredit: Handler = async (row, tx) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      await creditHandler(row, tx);
    };
    const worker = createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': slowCredit }, batchSize: 2 });
    const status = async () =>
      Object.fromEntries((await pool.query(`SELECT status, count(*)::int n FROM webhook_inbox GROUP BY status`)).rows.map((r) => [r.status, r.n]));

    const stop = new AbortController();
    const running = worker.run({ loops: 4, idleMs: 10, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 60)); // every loop is busy with its 2-row batch
    stop.abort(); // a deploy's SIGTERM
    await running;
    assert.equal((await status()).processing, undefined, 'no claimed row left stranded in processing');
    assert.equal(maxActive, 4, 'the loops ran in parallel');

    const again = new AbortController();
    const restarted = worker.run({ loops: 4, idleMs: 10, signal: again.signal });
    while ((await status()).pending) await new Promise((r) => setTimeout(r, 10));
    again.abort();
    await restarted;
    assert.deepEqual(await status(), { done: 12 });
    assert.equal((await pool.query('SELECT count(*)::int n FROM credits')).rows[0].n, 12);
  });

  it('unknown event types are acknowledged, not retried forever', async () => {
    await ingest(pool, evt('evt_5', 'customer.updated'));
    const worker = createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': creditHandler } });
    assert.deepEqual(await worker.processOnce(), ['ignored']);
  });

  it('reconciliation ingests only the events we missed', async () => {
    await ingest(pool, evt('evt_6'));
    const remote = [evt('evt_6'), evt('evt_7'), evt('evt_8')];
    assert.deepEqual(await reconcile(pool, remote), { missed: 2 });
    const { rows } = await pool.query(`SELECT event_id, source FROM webhook_inbox ORDER BY event_id`);
    assert.deepEqual(rows.map((r) => `${r.event_id}:${r.source}`), ['evt_6:webhook', 'evt_7:reconcile', 'evt_8:reconcile']);
  });

  it('backoff grows exponentially with jitter and is capped', () => {
    assert.equal(backoffMs(1, 1000, 60_000, () => 0), 500);
    assert.equal(backoffMs(1, 1000, 60_000, () => 1), 1000);
    assert.equal(backoffMs(4, 1000, 60_000, () => 1), 8000);
    assert.equal(backoffMs(30, 1000, 60_000, () => 1), 60_000);
  });
});
