import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase } from '../support/infra.ts';
import { sleep } from '../support/wait.ts';
import { backfill, runStep } from '../../../skills/zero-downtime-migrations/references/migrate.ts';
import { lintMigration } from '../../../skills/zero-downtime-migrations/references/lint.ts';

let pool: pg.Pool;

async function resetAccounts(rows: number) {
  await pool.query(`DROP TABLE IF EXISTS accounts CASCADE`);
  await pool.query(`CREATE TABLE accounts (id bigserial PRIMARY KEY, email text NOT NULL, plan text, amount int NOT NULL DEFAULT 0)`);
  await pool.query(
    `INSERT INTO accounts (email, plan, amount) SELECT md5(g::text) || '@example.com', 'free', g % 1000 FROM generate_series(1, $1::int) g`,
    [rows],
  );
}
const columnExists = async (name: string) =>
  (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = $1`, [name])).rowCount === 1;

describe('zero-downtime-migrations', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: await freshDatabase('kit_migrations'), max: 8 });
  });
  after(async () => pool?.end());

  it('a DDL statement waiting for its lock stalls every query behind it; lock_timeout caps the stall and the runner retries', async () => {
    await resetAccounts(1000);
    const report = await pool.connect();
    const timeRead = async () => {
      const t0 = performance.now();
      await pool.query('SELECT 1 FROM accounts LIMIT 1');
      return performance.now() - t0;
    };

    // Without lock_timeout: the ALTER queues behind a 700 ms report, and so does every read that arrives after it.
    await report.query('BEGIN');
    await report.query('SELECT count(*) FROM accounts');
    const plainAlter = pool.query('ALTER TABLE accounts ADD COLUMN note text');
    await sleep(100);
    const readBehindAlter = timeRead();
    await sleep(600);
    await report.query('COMMIT');
    await plainAlter;
    const stalled = await readBehindAlter;
    assert.ok(stalled > 500, `a plain read stalled ${Math.round(stalled)} ms behind the waiting ALTER`);

    // With runStep: the ALTER gives up after 100 ms, so reads wait at most that long, and it lands once the report ends.
    await report.query('BEGIN');
    await report.query('SELECT count(*) FROM accounts');
    const retries: number[] = [];
    const step = runStep(
      pool,
      { name: 'add note2', sql: 'ALTER TABLE accounts ADD COLUMN note2 text' },
      { lockTimeoutMs: 100, baseDelayMs: 100, onRetry: (_s, attempt) => retries.push(attempt) },
    );
    await sleep(50);
    const capped = await timeRead();
    await sleep(500);
    await report.query('COMMIT');
    report.release();
    const { attempts } = await step;
    assert.ok(capped < 250, `with lock_timeout the read waited ${Math.round(capped)} ms`);
    assert.ok(attempts > 1, 'the first attempt timed out');
    assert.equal(retries.length, attempts - 1);
    assert.equal(await columnExists('note2'), true);
  });

  it('CREATE INDEX blocks writes for the whole build; CREATE INDEX CONCURRENTLY lets them through', async () => {
    await resetAccounts(300_000);
    const insertDuring = async (ddl: string) => {
      const build = (async () => {
        const t0 = performance.now();
        await pool.query(ddl);
        return performance.now() - t0;
      })();
      await sleep(40);
      const t0 = performance.now();
      await pool.query(`INSERT INTO accounts (email, plan) VALUES ('new@example.com', 'free')`);
      return { insertMs: performance.now() - t0, buildMs: await build };
    };
    const plain = await insertDuring('CREATE INDEX accounts_email_idx ON accounts (email)');
    await pool.query('DROP INDEX accounts_email_idx');
    const concurrent = await insertDuring('CREATE INDEX CONCURRENTLY accounts_email_idx ON accounts (email)');
    assert.ok(plain.buildMs > 100, `the build must take a while for this to mean anything: ${Math.round(plain.buildMs)} ms`);
    assert.ok(plain.insertMs > plain.buildMs * 0.5, `the insert waited ${Math.round(plain.insertMs)} ms of a ${Math.round(plain.buildMs)} ms build`);
    assert.ok(concurrent.insertMs < 100, `insert during the concurrent build: ${Math.round(concurrent.insertMs)} ms`);
  });

  it('a failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind; runStep drops it', async () => {
    await resetAccounts(1000);
    await pool.query(`INSERT INTO accounts (email, plan) VALUES ('dup@example.com', 'free'), ('dup@example.com', 'free')`);
    const invalid = async () =>
      (await pool.query(`SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid = 'accounts'::regclass AND NOT indisvalid`)).rows.map(
        (r) => r.name,
      );
    await assert.rejects(pool.query('CREATE UNIQUE INDEX CONCURRENTLY accounts_email_raw_key ON accounts (email)'), (e: any) => e.code === '23505');
    assert.deepEqual(await invalid(), ['accounts_email_raw_key'], 'plain Postgres leaves the broken index');
    await assert.rejects(
      runStep(pool, { name: 'unique email', sql: 'CREATE UNIQUE INDEX CONCURRENTLY accounts_email_key ON accounts (email)' }),
      (e: any) => e.code === '23505',
    );
    assert.deepEqual(await invalid(), ['accounts_email_raw_key'], 'runStep removed the one it created');
  });

  it('NOT NULL without a long lock: CHECK NOT VALID, VALIDATE next to open writes, then SET NOT NULL skips the scan', async () => {
    await resetAccounts(5000);
    await runStep(pool, { name: 'check', sql: `ALTER TABLE accounts ADD CONSTRAINT accounts_plan_not_null CHECK (plan IS NOT NULL) NOT VALID` });
    const writer = await pool.connect();
    await writer.query('BEGIN');
    await writer.query(`INSERT INTO accounts (email, plan) VALUES ('w@example.com', 'pro')`); // a write transaction stays open
    await runStep(pool, { name: 'validate', sql: 'ALTER TABLE accounts VALIDATE CONSTRAINT accounts_plan_not_null' }, { lockTimeoutMs: 300, attempts: 1 });
    await assert.rejects(
      runStep(pool, { name: 'not null', sql: 'ALTER TABLE accounts ALTER COLUMN plan SET NOT NULL' }, { lockTimeoutMs: 200, attempts: 1 }),
      (e: any) => e.code === '55P03',
      'SET NOT NULL needs ACCESS EXCLUSIVE and has to wait for open writes',
    );
    await writer.query('COMMIT');
    writer.release();

    const c = await pool.connect();
    const notices: string[] = [];
    const onNotice = (n: { message?: string }) => notices.push(n.message ?? '');
    c.on('notice', onNotice);
    await c.query('SET client_min_messages = debug1');
    await c.query('ALTER TABLE accounts ALTER COLUMN plan SET NOT NULL');
    await c.query('RESET client_min_messages');
    c.off('notice', onNotice);
    c.release();
    assert.ok(
      notices.some((m) => /sufficient to prove that it does not contain nulls/.test(m)),
      `Postgres skipped the scan: ${JSON.stringify(notices)}`,
    );
  });

  it('which changes rewrite the table: a stable default no, a volatile default yes, int → bigint yes, varchar → text no', async () => {
    await resetAccounts(1000);
    await pool.query('ALTER TABLE accounts ADD COLUMN code varchar(20)');
    const filenode = async () => (await pool.query(`SELECT pg_relation_filenode('accounts') AS f`)).rows[0].f;
    const rewrites = async (sql: string) => {
      const before = await filenode();
      await pool.query(sql);
      return (await filenode()) !== before;
    };
    assert.deepEqual(
      {
        'DEFAULT now()': await rewrites(`ALTER TABLE accounts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()`),
        'DEFAULT gen_random_uuid()': await rewrites(`ALTER TABLE accounts ADD COLUMN token uuid DEFAULT gen_random_uuid()`),
        'int → bigint': await rewrites(`ALTER TABLE accounts ALTER COLUMN amount TYPE bigint`),
        'varchar(20) → text': await rewrites(`ALTER TABLE accounts ALTER COLUMN code TYPE text`),
      },
      { 'DEFAULT now()': false, 'DEFAULT gen_random_uuid()': true, 'int → bigint': true, 'varchar(20) → text': false },
    );
  });

  it('backfill updates in short batches and picks up where an interrupted run stopped', async () => {
    await resetAccounts(25_000);
    await pool.query('ALTER TABLE accounts ADD COLUMN plan_v2 text');
    const sizes: number[] = [];
    let previous = 0;
    const track = (done: number) => {
      sizes.push(done - previous);
      previous = done;
    };
    await assert.rejects(
      backfill(pool, {
        table: 'accounts',
        set: 'plan_v2 = upper(plan)',
        where: 'plan_v2 IS NULL',
        batchSize: 5000,
        pauseMs: 0,
        onBatch: (done) => {
          track(done);
          if (done >= 10_000) throw new Error('deploy interrupted the backfill');
        },
      }),
      /interrupted/,
    );
    previous = 0;
    const resumed = await backfill(pool, { table: 'accounts', set: 'plan_v2 = upper(plan)', where: 'plan_v2 IS NULL', batchSize: 5000, pauseMs: 0, onBatch: track });
    assert.equal(resumed.updated, 15_000, 'only the rows still to do');
    assert.ok(sizes.every((n) => n <= 5000));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM accounts WHERE plan_v2 IS DISTINCT FROM upper(plan)`)).rows[0].n, 0);
  });

  it('the linter flags the statements that lock or break the running app, and leaves the safe ones alone', () => {
    const findings = lintMigration(`
      -- a brand-new table: nothing reads it yet
      CREATE TABLE invoices (id bigserial PRIMARY KEY, account_id bigint NOT NULL);
      CREATE INDEX invoices_account_idx ON invoices (account_id);
      ALTER TABLE invoices ADD CONSTRAINT invoices_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id);
      -- existing tables
      CREATE INDEX accounts_plan_idx ON accounts (plan);
      CREATE INDEX CONCURRENTLY accounts_email_idx ON accounts (email);
      ALTER TABLE accounts ADD COLUMN token uuid DEFAULT gen_random_uuid();
      ALTER TABLE accounts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE accounts ADD CONSTRAINT accounts_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id);
      ALTER TABLE accounts ADD CONSTRAINT accounts_owner_fk2 FOREIGN KEY (owner_id) REFERENCES users (id) NOT VALID;
      ALTER TABLE accounts VALIDATE CONSTRAINT accounts_owner_fk2;
      ALTER TABLE accounts ALTER COLUMN amount TYPE bigint;
      ALTER TABLE accounts ALTER COLUMN plan SET NOT NULL;
      ALTER TABLE accounts ADD CONSTRAINT accounts_email_key UNIQUE (email);
      ALTER TABLE accounts ADD CONSTRAINT accounts_email_key2 UNIQUE USING INDEX accounts_email_idx;
      ALTER TABLE accounts RENAME COLUMN plan TO tier;
      UPDATE accounts SET tier = 'free';
      UPDATE accounts SET tier = 'free' WHERE id < 1000;
      CREATE FUNCTION touch() RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE accounts SET tier = 'x'; END $$;
    `);
    assert.deepEqual(
      findings.map((f) => `${f.severity} ${f.rule}`),
      [
        'error index-not-concurrent',
        'error add-column-volatile-default',
        'error constraint-not-valid',
        'warning alter-column-type',
        'warning set-not-null',
        'error unique-without-index',
        'warning breaks-running-code',
        'warning unbatched-dml',
      ],
    );
    assert.deepEqual(
      lintMigration(`BEGIN; CREATE INDEX CONCURRENTLY accounts_x_idx ON accounts (email); COMMIT;`).map((f) => f.rule),
      ['concurrently-in-transaction'],
    );
  });
});
