// A connection that dies in the middle of a transaction must fail that request, not the process.
// pg emits 'error' on a checked-out client whose server connection ends while no query is running: a failover,
// pg_terminate_backend, or idle_in_transaction_session_timeout during a slow handler or publish. With no
// listener that is an uncaught exception: node:test fails this file, and a real server exits with every
// in-flight request. Each function below checks a client out of the pool and runs caller code in between.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile, sleep } from './helpers.ts';
import { withTenant } from '../../skills/multitenant-postgres/references/tenant-db.ts';
import { consumeOnce, createRelay, enqueue } from '../../skills/outbox-pattern/references/outbox.ts';
import { createInboxWorker, ingest } from '../../skills/webhook-ingestion/references/webhooks.ts';
import { requestFingerprint, runIdempotent } from '../../skills/idempotency-keys/references/idempotency.ts';

let pool: pg.Pool;

/** End `pid`'s server connection from another one, then stay idle while the FATAL message arrives. */
async function terminate(pid: number) {
  await pool.query('SELECT pg_terminate_backend($1)', [pid]);
  await sleep(150);
}
const dieUnder = async (client: pg.PoolClient) => terminate((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
const stillServing = async () => assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1);

describe('connection loss mid-transaction fails the request, not the process', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_connection_loss'), max: 5 });
    pool.on('error', () => {}); // idle clients are the app's job: one pool-level listener (service-hardening)
    await runSqlFile(pool, 'outbox-pattern', 'outbox.sql');
    await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
    await runSqlFile(pool, 'idempotency-keys', 'idempotency.sql');
  });
  after(async () => pool?.end());

  it('multitenant-postgres: withTenant rejects', async () => {
    await assert.rejects(withTenant(pool, '11111111-1111-4111-8111-111111111111', dieUnder));
    await stillServing();
  });

  it('outbox-pattern: relayOnce rejects when its session dies during a slow publish, and the message goes out next run', async () => {
    const tx = await pool.connect();
    await tx.query('BEGIN');
    await enqueue(tx, { aggregateType: 'order', aggregateId: 'o-1', eventType: 'order.placed', payload: {} });
    await tx.query('COMMIT');
    tx.release();
    let slowBroker = true;
    const relay = createRelay({
      pool,
      publish: async () => {
        if (!slowBroker) return;
        slowBroker = false;
        // The relay's connection is the one sitting idle in its transaction while this publish runs.
        const { rows } = await pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`,
        );
        await terminate(rows[0].pid);
      },
    });
    await assert.rejects(relay.relayOnce());
    assert.equal(await relay.relayOnce(), 1, 'not marked, so published again (consumers dedup)');
    await stillServing();
  });

  it('outbox-pattern: consumeOnce rejects, the dedup mark rolls back, and the retry applies', async () => {
    const id = '0b5c4c1e-7a4a-4d2b-9d7e-3f1a2b3c4d5e';
    await assert.rejects(consumeOnce(pool, 'billing', id, dieUnder));
    assert.equal(await consumeOnce(pool, 'billing', id, async () => {}), 'applied');
    await stillServing();
  });

  it('webhook-ingestion: the event goes back to pending with a backoff', async () => {
    await ingest(pool, { provider: 'stripe', eventId: 'evt_lost', eventType: 'payment.succeeded', payload: {} });
    const worker = createInboxWorker({ pool, handlers: { 'stripe:payment.succeeded': (_row, tx) => dieUnder(tx) } });
    assert.deepEqual(await worker.processOnce(), ['retry']);
    assert.equal((await pool.query(`SELECT status FROM webhook_inbox WHERE event_id = 'evt_lost'`)).rows[0].status, 'pending');
    await stillServing();
  });

  it('idempotency-keys: runIdempotent rejects, nothing is stored, and the same key can be retried', async () => {
    const req = { scope: 's', key: 'k-lost', fingerprint: requestFingerprint('POST', '/orders', {}) };
    await assert.rejects(
      runIdempotent(pool, req, async (tx) => {
        await dieUnder(tx);
        return { status: 201, body: {} };
      }),
    );
    assert.equal((await runIdempotent(pool, req, async () => ({ status: 201, body: { ok: true } }))).replayed, false);
    await stillServing();
  });
});
