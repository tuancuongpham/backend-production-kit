// Schema changes on a 1,000,000-row table that the app keeps reading and writing: how long does each way of
// making the change block the app?
//   1. a DDL statement queued behind a 1 s report, with and without lock_timeout (reads arriving meanwhile)
//   2. CREATE INDEX vs CREATE INDEX CONCURRENTLY (an insert arriving during the build)
//   3. SET NOT NULL directly vs CHECK NOT VALID + VALIDATE + SET NOT NULL
//   4. ADD COLUMN with a stable default vs a volatile one
// Run inside the Docker network:  npm run bench:docker -- bench/compare/migrations.ts
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { freshDatabase } from '../../verify/tests/support/infra.ts';
import { runStep } from '../../skills/zero-downtime-migrations/references/migrate.ts';
import { save, table } from './lib.ts';

const ROWS = 1_000_000;
const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_migrations'), max: 8 });
const reset = async () => {
  await pool.query(`DROP TABLE IF EXISTS accounts CASCADE`);
  await pool.query(`CREATE TABLE accounts (id bigserial PRIMARY KEY, email text NOT NULL, plan text, amount int NOT NULL DEFAULT 0)`);
  await pool.query(`INSERT INTO accounts (email, plan, amount) SELECT md5(g::text) || '@example.com', 'free', g % 1000 FROM generate_series(1, ${ROWS}) g`);
  await pool.query(`VACUUM ANALYZE accounts`);
};
const timed = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return Math.round(performance.now() - t0);
};
/** Runs `ddl`; 40 ms in, times a write (or read) that arrives while it runs. */
const during = async (ddl: () => Promise<unknown>, probe: string) => {
  const running = timed(ddl);
  await sleep(40);
  const probeMs = await timed(() => pool.query(probe));
  return { ddlMs: await running, probeMs };
};
const INSERT = `INSERT INTO accounts (email, plan) VALUES ('new@example.com', 'free')`;
const rows: Array<Record<string, unknown>> = [];
console.log(`loading ${ROWS.toLocaleString('en-US')} rows…`);
await reset();

// 1. Lock queue behind a long report.
for (const [variant, run] of [
  ['ALTER TABLE, no lock_timeout', () => pool.query('ALTER TABLE accounts ADD COLUMN note1 text')],
  ['runStep, lock_timeout 100 ms + retry', () => runStep(pool, { name: 'note2', sql: 'ALTER TABLE accounts ADD COLUMN note2 text' }, { lockTimeoutMs: 100, baseDelayMs: 100 })],
] as const) {
  const report = await pool.connect();
  await report.query('BEGIN');
  await report.query('SELECT count(*) FROM accounts');
  const ddl = timed(run);
  await sleep(50);
  const readMs = timed(() => pool.query('SELECT id FROM accounts WHERE id = 42'));
  await sleep(1000);
  await report.query('COMMIT');
  report.release();
  rows.push({ change: 'add a column while a 1 s report runs', variant, 'change took, ms': await ddl, 'a read arriving meanwhile waited, ms': await readMs });
}

// 2. Index build.
const plain = await during(() => pool.query('CREATE INDEX accounts_email_idx ON accounts (email)'), INSERT);
rows.push({ change: 'index on email', variant: 'CREATE INDEX', 'change took, ms': plain.ddlMs, 'an insert arriving meanwhile waited, ms': plain.probeMs });
await pool.query('DROP INDEX accounts_email_idx');
const conc = await during(() => pool.query('CREATE INDEX CONCURRENTLY accounts_email_idx ON accounts (email)'), INSERT);
rows.push({ change: 'index on email', variant: 'CREATE INDEX CONCURRENTLY', 'change took, ms': conc.ddlMs, 'an insert arriving meanwhile waited, ms': conc.probeMs });

// 3. NOT NULL.
const direct = await during(() => pool.query('ALTER TABLE accounts ALTER COLUMN plan SET NOT NULL'), INSERT);
rows.push({ change: 'plan NOT NULL', variant: 'SET NOT NULL (full scan under ACCESS EXCLUSIVE)', 'change took, ms': direct.ddlMs, 'an insert arriving meanwhile waited, ms': direct.probeMs });
await pool.query('ALTER TABLE accounts ALTER COLUMN plan DROP NOT NULL');
const addCheck = await timed(() => pool.query(`ALTER TABLE accounts ADD CONSTRAINT accounts_plan_nn CHECK (plan IS NOT NULL) NOT VALID`));
const validate = await during(() => pool.query('ALTER TABLE accounts VALIDATE CONSTRAINT accounts_plan_nn'), INSERT);
const setNotNull = await timed(() => pool.query('ALTER TABLE accounts ALTER COLUMN plan SET NOT NULL'));
rows.push({
  change: 'plan NOT NULL',
  variant: `CHECK NOT VALID (${addCheck} ms) → VALIDATE (${validate.ddlMs} ms, writes allowed) → SET NOT NULL`,
  'change took, ms': addCheck + validate.ddlMs + setNotNull,
  'an insert arriving meanwhile waited, ms': validate.probeMs,
  'longest exclusive lock, ms': Math.max(addCheck, setNotNull),
});
rows[rows.length - 2]['longest exclusive lock, ms'] = direct.ddlMs;

// 4. New column with a default.
for (const [variant, ddl] of [
  ['DEFAULT now() (stable: stored once in the catalog)', `ALTER TABLE accounts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()`],
  ['DEFAULT gen_random_uuid() (volatile: rewrites every row)', `ALTER TABLE accounts ADD COLUMN token uuid DEFAULT gen_random_uuid()`],
] as const) {
  const r = await during(() => pool.query(ddl), INSERT);
  rows.push({ change: 'add a column with a default', variant, 'change took, ms': r.ddlMs, 'an insert arriving meanwhile waited, ms': r.probeMs, 'longest exclusive lock, ms': r.ddlMs });
}

table(rows.map((r) => ({ 'longest exclusive lock, ms': '', 'a read arriving meanwhile waited, ms': '', 'an insert arriving meanwhile waited, ms': '', ...r })));
save('migrations', { rows: ROWS, results: rows });
await pool.end();
