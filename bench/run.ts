// Micro-benchmarks for the reference code's hot paths. Needs `npm run verify:up` (Postgres + Redis).
//   node bench/run.ts [label]      → prints a table and writes bench/results-<label>.json
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { Redis } from 'ioredis';
import { freshDatabase, REDIS_URL, runSqlFile, sleep } from '../verify/tests/helpers.ts';
import { createRedactor } from '../skills/pii-redaction/references/redact.ts';
import { createRateLimiter } from '../skills/rate-limiting/references/limiter.ts';
import { createInboxWorker, ingest } from '../skills/webhook-ingestion/references/webhooks.ts';

const label = process.argv[2] ?? 'current';
const results: Record<string, { value: number; unit: string; note: string }> = {};
const record = (name: string, value: number, unit: string, note: string) => {
  results[name] = { value: Math.round(value * 100) / 100, unit, note };
  console.log(`${name.padEnd(34)} ${String(results[name].value).padStart(10)} ${unit.padEnd(10)} ${note}`);
};

// 1. Redaction of a large log string with no '@' (worst case for an unbounded email regex).
{
  const r = createRedactor();
  const blob = 'x'.repeat(50_000);
  const t0 = performance.now();
  r.redactString(blob);
  record('redact: 50 KB string, no @', performance.now() - t0, 'ms/call', 'one log line carrying a large payload');
}

// 2. Redaction throughput on a realistic structured log record.
{
  const r = createRedactor();
  const rec = {
    level: 'info',
    msg: 'order paid by alice@example.com via card 4111 1111 1111 1111',
    req: { method: 'POST', url: '/v1/orders/42/pay', headers: { authorization: 'Bearer abcdefghijkl', 'user-agent': 'Mozilla/5.0' } },
    user: { id: 'u_123', email: 'alice@example.com', phone: '0901234567' },
    order: { id: 'ord_9f2c', total: 125000, items: [{ sku: 'A-1', qty: 2 }, { sku: 'B-7', qty: 1 }] },
    durationMs: 183,
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  };
  const n = 20_000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) r.redactValue(rec);
  record('redact: structured log records', (n / (performance.now() - t0)) * 1000, 'records/s', '10 fields, nested, 3 PII values');
}

// 3. Rate limiter round trips against Redis.
{
  const redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 500, lazyConnect: true });
  await redis.connect();
  const rl = createRateLimiter({ redis, capacity: 1e9, refillPerSec: 1e9, failureMode: 'closed', keyPrefix: `bench${Date.now()}`, timeoutMs: 500 });
  for (let i = 0; i < 200; i++) await rl.check('warmup');
  const n = 3000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await rl.check(`tenant:${i % 50}`);
  const ms = performance.now() - t0;
  record('rate limiter: sequential checks', (n / ms) * 1000, 'checks/s', `avg ${(ms / n).toFixed(3)} ms per check`);
  redis.disconnect();
}

// 4. Webhook worker drain time with handlers that do ~5 ms of I/O each.
{
  const pool = new pg.Pool({ connectionString: await freshDatabase('kit_bench_webhooks'), max: 20 });
  await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
  const n = 200;
  for (let i = 0; i < n; i++) await ingest(pool, { provider: 'stripe', eventId: `evt_${i}`, eventType: 'payment.succeeded', payload: { i } });
  const worker = createInboxWorker({
    pool,
    batchSize: 50,
    handlers: { 'stripe:payment.succeeded': async () => sleep(5) },
    ...({ concurrency: 8 } as object), // ignored by versions without the option
  });
  const t0 = performance.now();
  while ((await worker.processOnce()).length > 0);
  record('webhook worker: drain 200 events', performance.now() - t0, 'ms', 'handler ≈ 5 ms I/O; concurrency 8 where supported');
  await pool.end();
}

writeFileSync(new URL(`./results-${label}.json`, import.meta.url), JSON.stringify({ label, date: new Date().toISOString(), node: process.version, results }, null, 2) + '\n');
