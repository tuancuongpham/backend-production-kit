// shared/pg-transaction.ts: transactions that always end, and a dead connection that fails its call, not the process.
// The same rule, checked in every skill that holds a connection, is in invariants/connection-loss.test.ts.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { withClient, withTransaction } from '../../../shared/pg-transaction.ts';
import { freshDatabase } from '../support/infra.ts';
import { sleep } from '../support/wait.ts';

let dbUrl: string;
let pool: pg.Pool;
const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM notes`)).rows[0].n;

describe('kernel: withClient and withTransaction', () => {
  before(async () => {
    dbUrl = await freshDatabase('kit_kernel_tx');
    pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
    await pool.query(`CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL)`);
  });
  after(async () => pool?.end());

  it('commits what fn wrote, and rolls all of it back when fn throws', async () => {
    await withTransaction(pool, (tx) => tx.query(`INSERT INTO notes (body) VALUES ('kept')`));
    await assert.rejects(
      withTransaction(pool, async (tx) => {
        await tx.query(`INSERT INTO notes (body) VALUES ('rolled back')`);
        throw new Error('the handler failed after its first write');
      }),
      /handler failed/,
    );
    assert.equal(await count(), 1);
  });

  it('`begin` replaces BEGIN: a READ ONLY transaction refuses writes', async () => {
    await assert.rejects(
      withTransaction(pool, (tx) => tx.query(`INSERT INTO notes (body) VALUES ('x')`), { begin: 'BEGIN READ ONLY' }),
      (err: { code?: string }) => err.code === '25006',
    );
  });

  it('a connection the server ends mid-call aborts `lost`, fails that call only, and is not reused', async () => {
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    let sawLost = false;
    await assert.rejects(
      withClient(pool, async (client, lost) => {
        const { rows } = await client.query(`SELECT pg_backend_pid() AS pid`);
        await admin.query(`SELECT pg_terminate_backend($1)`, [rows[0].pid]);
        await sleep(100); // the server's goodbye arrives while the caller awaits something else
        sawLost = lost.aborted;
        await client.query('SELECT 1');
      }),
    );
    await admin.end();
    assert.equal(sawLost, true);
    assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the pool hands out a live connection next');
  });
});
