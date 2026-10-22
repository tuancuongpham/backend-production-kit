// Idempotency keys: what they cost per request, and how three ways of claiming a key behave when a client
// fires the same request 20 times at once (double-click, retry storm, an agent re-running a tool call).
//   A. check, then insert    SELECT the key; if absent run the handler and INSERT the key with the response
//   B. insert first, block   INSERT … ON CONFLICT DO NOTHING; duplicates wait for the first transaction
//   C. shipped               advisory try-lock + claim in one statement; duplicates get 409 at once
// Run inside the Docker network:  npm run bench:docker -- bench/compare/idempotency.ts
import pg from 'pg';
import { freshDatabase, runSqlFile } from '../../verify/tests/support/infra.ts';
import { sleep } from '../../verify/tests/support/wait.ts';
import {
  IdempotencyError,
  requestFingerprint,
  runIdempotent,
  type IdempotentRequest,
  type IdempotentResult,
  type StoredResponse,
} from '../../skills/idempotency-keys/references/idempotency.ts';
import { latency, save, table } from './lib.ts';

const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_idempotency'), max: 25 });
await runSqlFile(pool, 'idempotency-keys', 'idempotency.sql');
await pool.query(`CREATE TABLE orders (id bigserial PRIMARY KEY, item text NOT NULL)`);

type Handler = (tx: pg.PoolClient) => Promise<StoredResponse>;
type Variant = (r: IdempotentRequest, fn: Handler) => Promise<IdempotentResult>;

async function inTx<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await work(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const replayOf = (row: { fingerprint: string; status: string; response_status: number; response_body: unknown }, r: IdempotentRequest) => {
  if (row.fingerprint !== r.fingerprint) throw new IdempotencyError(422, 'key_reused', 'key reused');
  if (row.status !== 'done') throw new IdempotencyError(409, 'in_progress', 'in progress');
  return { status: row.response_status, body: row.response_body, replayed: true };
};
const SELECT_KEY = `SELECT fingerprint, status, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2`;

const variants: Record<string, Variant> = {
  'A. check, then insert': (r, fn) =>
    inTx(async (c) => {
      const { rows } = await c.query(SELECT_KEY, [r.scope, r.key]);
      if (rows[0]) return replayOf(rows[0], r);
      const res = await fn(c);
      await c.query(
        `INSERT INTO idempotency_keys (scope, key, fingerprint, status, response_status, response_body, expires_at)
         VALUES ($1, $2, $3, 'done', $4, $5, now() + interval '1 day')`,
        [r.scope, r.key, r.fingerprint, res.status, JSON.stringify(res.body)],
      );
      return { ...res, replayed: false };
    }),
  'B. insert first, duplicates wait': (r, fn) =>
    inTx(async (c) => {
      const claimed = await c.query(
        `INSERT INTO idempotency_keys (scope, key, fingerprint, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')
         ON CONFLICT DO NOTHING RETURNING 1`,
        [r.scope, r.key, r.fingerprint],
      );
      if (claimed.rowCount === 0) return replayOf((await c.query(SELECT_KEY, [r.scope, r.key])).rows[0], r);
      const res = await fn(c);
      await c.query(
        `UPDATE idempotency_keys SET status = 'done', response_status = $3, response_body = $4 WHERE scope = $1 AND key = $2`,
        [r.scope, r.key, res.status, JSON.stringify(res.body)],
      );
      return { ...res, replayed: false };
    }),
  'C. shipped runIdempotent (409 at once)': (r, fn) => runIdempotent(pool, r, fn),
};

// The first draft of C: claim and read the existing record in one statement (CTE + join). One round trip
// fewer on a replay, but a heavier statement on every first request, which is the common case.
const CTE_CLAIM = `
  WITH lock AS (SELECT pg_try_advisory_xact_lock(hashtextextended($2, hashtextextended($1, 0))) AS got),
  claimed AS (
    INSERT INTO idempotency_keys AS k (scope, key, fingerprint, expires_at)
    SELECT $1, $2, $3, now() + interval '1 day' FROM lock WHERE got
    ON CONFLICT (scope, key) DO UPDATE
      SET fingerprint = EXCLUDED.fingerprint, status = 'in_progress', locked_at = now(), created_at = now(),
          response_status = NULL, response_body = NULL, response_headers = NULL, expires_at = EXCLUDED.expires_at
      WHERE k.expires_at <= now()
         OR (k.status = 'in_progress' AND k.locked_at < now() - interval '60 seconds' AND k.fingerprint = EXCLUDED.fingerprint)
    RETURNING 1)
  SELECT lock.got, (SELECT count(*) FROM claimed)::int AS claimed, k.fingerprint, k.status, k.response_status, k.response_body
  FROM lock LEFT JOIN idempotency_keys k ON k.scope = $1 AND k.key = $2`;
const draftC: Variant = async (r, fn) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const row = (await c.query(CTE_CLAIM, [r.scope, r.key, r.fingerprint])).rows[0];
    if (row.claimed !== 1) {
      // Like the shipped code, end a replay with ROLLBACK: the claim's ON CONFLICT DO UPDATE locked the row, and
      // committing that lock would wait for a WAL flush.
      await c.query('ROLLBACK');
      if (!row.got || row.status === null) throw new IdempotencyError(409, 'in_progress', 'in progress');
      return replayOf(row, r);
    }
    const res = await fn(c);
    await c.query(
      `UPDATE idempotency_keys SET status = 'done', response_status = $3, response_body = $4 WHERE scope = $1 AND key = $2`,
      [r.scope, r.key, res.status, JSON.stringify(res.body)],
    );
    await c.query('COMMIT');
    return { ...res, replayed: false };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
};

let runs = 0;
const createOrder =
  (workMs: number): Handler =>
  async (tx) => {
    runs++;
    const { rows } = await tx.query(`INSERT INTO orders (item) VALUES ('book') RETURNING id`);
    if (workMs) await sleep(workMs);
    return { status: 201, body: { orderId: Number(rows[0].id) } };
  };
const request = (key: string): IdempotentRequest => ({ scope: 'tenant-1:user-1', key, fingerprint: requestFingerprint('POST', '/orders', { item: 'book' }) });

// 1. Cost per request, sequential, handler = one INSERT.
const latencyRows: Array<Record<string, unknown>> = [];
const plain = await latency(1000, () => inTx((c) => c.query(`INSERT INTO orders (item) VALUES ('book')`)));
latencyRows.push({ variant: 'no idempotency (BEGIN, INSERT, COMMIT)', 'first request p50 ms': plain.p50, 'replay p50 ms': '—' });
const { 'C. shipped runIdempotent (409 at once)': shipped, ...naive } = variants;
const latencyVariants: Record<string, Variant> = {
  ...naive,
  'C0. first draft of C: claim + read in one statement': draftC,
  'C. shipped runIdempotent (409 at once)': shipped,
};
let n = 0;
for (const [name, run] of Object.entries(latencyVariants)) {
  const prefix = `seq-${n++}-`;
  const first = await latency(1000, (i) => run(request(`${prefix}${i}`), createOrder(0)));
  const replay = await latency(1000, (i) => run(request(`${prefix}${i % 1000}`), createOrder(0)));
  latencyRows.push({ variant: name, 'first request p50 ms': first.p50, 'replay p50 ms': replay.p50 });
}
table(latencyRows);

// 2. Burst: 20 copies of one request at once; the handler takes 200 ms (a slow INSERT, a lock wait…).
await Promise.all(Array.from({ length: 22 }, () => pool.query('SELECT 1'))); // open the connections first
const burstRows: Array<Record<string, unknown>> = [];
for (const [name, run] of Object.entries(variants)) {
  await pool.query('TRUNCATE orders, idempotency_keys');
  runs = 0;
  const key = `burst-${name}`;
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const t0 = performance.now();
      try {
        const res = await run(request(key), createOrder(200));
        return { kind: res.replayed ? 'replay' : 'first', ms: performance.now() - t0 };
      } catch (e) {
        return { kind: e instanceof IdempotencyError ? String(e.status) : `error ${(e as { code?: string }).code ?? ''}`.trim(), ms: performance.now() - t0 };
      }
    }),
  );
  const count = (k: string) => outcomes.filter((o) => o.kind === k).length;
  const duplicates = outcomes.filter((o) => o.kind !== 'first');
  burstRows.push({
    variant: name,
    'handler runs': runs,
    'orders committed': (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n,
    'answers: first / replay / 409 / error': `${count('first')} / ${count('replay')} / ${count('409')} / ${outcomes.filter((o) => o.kind.startsWith('error')).length}`,
    'connection time held by the 19 duplicates, ms': Math.round(duplicates.reduce((s, o) => s + o.ms, 0)),
    'slowest duplicate answer, ms': Math.round(Math.max(...duplicates.map((o) => o.ms))),
  });
}
table(burstRows);
save('idempotency', { latency: latencyRows, burst: burstRows });
await pool.end();
