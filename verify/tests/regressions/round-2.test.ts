// Round 2 of the latent-bug review. Each test in "latent bugs" failed on the code before its fix.
// New functions are reached through namespace imports so this file also loads against older code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import pg from 'pg';
import { Redis } from 'ioredis';
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { freshDatabase, readSkillFile, REDIS_URL, runSqlFile } from '../support/infra.ts';
import { sleep } from '../support/wait.ts';
import * as outbox from '../../../skills/outbox-pattern/references/outbox.ts';
import * as sse from '../../../skills/sse-streaming/references/sse.ts';
import * as stores from '../../../skills/llm-gateway/references/pg-stores.ts';
import * as webhooks from '../../../skills/webhook-ingestion/references/webhooks.ts';
import * as tracing from '../../../skills/llm-observability/references/llm-tracing.ts';
import { createHardenedServer, readBody } from '../../../skills/service-hardening/references/server.ts';
import { createRateLimiter } from '../../../skills/rate-limiting/references/limiter.ts';

/** Deterministic unit-variance-ish vectors (mulberry32), independent across seeds. */
export function randomVector(seed: number, dims = 1536): number[] {
  let a = seed >>> 0;
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }
  return out;
}
const near = (center: number[], seed: number, sigma: number) => {
  const n = randomVector(seed, center.length);
  return center.map((x, i) => x + sigma * n[i]);
};
const lit = (v: number[]) => `[${v.join(',')}]`;

/** Stream `totalBytes` to POST /upload; resolves with the status (if any) once the connection closes. */
function upload(port: number, totalBytes: number, declareLength: boolean) {
  return new Promise<{ status?: number; error?: string }>((resolve) => {
    let status: number | undefined;
    let error: string | undefined;
    let sent = 0;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/upload',
      agent: false,
      headers: declareLength ? { 'content-length': String(totalBytes) } : {},
    });
    req.on('response', (res) => {
      status = res.statusCode;
      res.resume();
    });
    req.on('error', (e: NodeJS.ErrnoException) => (error = e.code ?? e.message));
    req.on('close', () => resolve({ status, error }));
    const chunk = Buffer.alloc(64 * 1024, 97);
    const pump = () => {
      while (sent < totalBytes && !req.destroyed) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once('drain', pump);
      }
      if (!req.destroyed) req.end();
    };
    pump();
  });
}

describe('latent bugs, round 2', () => {
  it('outbox-pattern: a publish call that never returns cannot stall the relay forever', async () => {
    const pool = new pg.Pool({ connectionString: await freshDatabase('kit_outbox_hang'), max: 4 });
    try {
      await runSqlFile(pool, 'outbox-pattern', 'outbox.sql');
      const c = await pool.connect();
      await c.query('BEGIN');
      await outbox.enqueue(c, { aggregateType: 'order', aggregateId: 'o1', eventType: 'order.placed', payload: {} });
      await c.query('COMMIT');
      c.release();

      const hanging = outbox.createRelay({ pool, publish: () => new Promise<void>(() => {}), publishTimeoutMs: 200 } as outbox.RelayOptions);
      const outcome = await Promise.race([hanging.relayOnce().then((n) => `returned ${n}`), sleep(3000).then(() => 'hung')]);
      // Before the fix the relay waited forever inside its transaction, holding the advisory lock:
      // every other relay instance skipped, and the outbox silently stopped publishing.
      assert.equal(outcome, 'returned 0');
      const row = (await pool.query(`SELECT attempts, last_error FROM outbox`)).rows[0];
      assert.equal(row.attempts, 1);
      assert.match(row.last_error, /timeout/i);
      const sent: string[] = [];
      assert.equal(await outbox.createRelay({ pool, publish: async (m) => void sent.push(m.id) }).relayOnce(), 1, 'lock released');
    } finally {
      await Promise.race([pool.end(), sleep(1000)]);
    }
  });

  it('sse-streaming: a client that falls too far behind is dropped instead of buffered without limit', async () => {
    const feed = sse.createReplayBuffer<string>(100);
    let overflowed = false;
    let serverSideClosed!: Promise<void>;
    const server = http.createServer((req, res) => {
      const stream = sse.openSse(req, res, { heartbeatMs: 60_000 });
      serverSideClosed = new Promise((r) => res.on('close', () => r()));
      void sse.serveFeed(stream, feed, { maxQueue: 100, onOverflow: () => (overflowed = true) } as never);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const client = http.get(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`, (res) => res.pause()); // never reads
    client.on('error', () => {});
    await sleep(100);
    const payload = 'x'.repeat(2048);
    for (let i = 0; i < 20_000; i++) feed.append(payload); // ≈ 40 MB published while this client is stuck
    const dropped = await Promise.race([serverSideClosed.then(() => true), sleep(2000).then(() => false)]);
    client.destroy();
    server.closeAllConnections();
    server.close();
    // Before the fix every event was queued in memory for this one client until TCP gave up (hours).
    assert.equal(overflowed, true);
    assert.equal(dropped, true);
  });

  it("llm-gateway: a tenant's semantic cache hit is found even when many tenants cached the same question", async () => {
    // Planner settings make Postgres pick the plan it uses on large tables (HNSW scan, tenant filter applied
    // afterwards); bench/compare/semantic-cache.ts measures the same effect on unforced plans.
    const dbUrl = await freshDatabase('kit_semcache_filter');
    const pool = new pg.Pool({ connectionString: dbUrl, options: '-c enable_seqscan=off -c enable_bitmapscan=off -c enable_sort=off' });
    try {
      await runSqlFile(pool, 'llm-gateway', 'semantic-cache.sql');
      await pool.query(`CREATE INDEX IF NOT EXISTS test_semantic_hnsw ON llm_semantic_cache USING hnsw (embedding vector_cosine_ops)`);
      const popular = randomVector(1); // "how do I reset my password?"
      for (let t = 0; t < 100; t++) {
        await pool.query(
          `INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at) VALUES ($1, $2::vector, $3, now() + interval '1 day')`,
          [`tenant-${t}`, lit(near(popular, 1000 + t, 0.1)), JSON.stringify({ content: `answer of tenant ${t}` })],
        );
      }
      // Our tenant phrased it a little differently: still 0.97 similar, well above the 0.95 threshold.
      await pool.query(
        `INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at) VALUES ('tenant-mine', $1::vector, $2, now() + interval '1 day')`,
        [lit(near(popular, 7, 0.25)), JSON.stringify({ content: 'our answer' })],
      );
      const hit = await stores.pgCache(pool).findSimilar('tenant-mine', near(popular, 99, 0.05), 0.95);
      // Before the fix the 40 nearest neighbours (hnsw.ef_search) all belonged to other tenants, so the
      // tenant filter removed every candidate: a paid model call for an answer we had cached.
      assert.ok(hit, 'own cached answer must be found');
      assert.equal(hit.value.content, 'our answer');
      assert.ok(hit.similarity > 0.95 && hit.similarity < 0.99);
    } finally {
      await pool.end();
    }
  });

  it('rate-limiting: a bucket that never refills is rejected at startup', async () => {
    // Evidence for the failure mode: with refillPerSec = 0 the script divides by zero and PEXPIRE gets
    // "inf", so *every* call errors — even allowed ones — and the limiter silently runs in failure mode.
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    try {
      const lua = await readSkillFile('rate-limiting', 'token-bucket.lua');
      await assert.rejects(redis.eval(lua, 1, `rl:zero:${Date.now()}`, 10, 0, 1));
    } finally {
      redis.disconnect();
    }
    const base = { redis: {} as never, failureMode: 'closed' as const };
    assert.throws(() => createRateLimiter({ ...base, capacity: 10, refillPerSec: 0 }), /refillPerSec/);
    assert.throws(() => createRateLimiter({ ...base, capacity: 0, refillPerSec: 1 }), /capacity/);
    assert.throws(() => createRateLimiter({ ...base, capacity: 10, refillPerSec: Number.NaN }), /refillPerSec/);
  });

  describe('service-hardening: oversized uploads', () => {
    const start = async () => {
      const srv = createHardenedServer({
        drainDelayMs: 10,
        rejectLingerMs: 300,
        handler: async (req, res) => {
          const body = await readBody(req, 1024);
          res.end(`got ${body.length}`);
        },
      });
      const sockets: net.Socket[] = [];
      srv.server.on('connection', (s) => sockets.push(s));
      return { srv, sockets, port: await srv.listen() };
    };
    const MB = 1024 * 1024;

    it('a chunked upload over the limit gets a 413, not a connection reset', async () => {
      const { srv, sockets, port } = await start();
      const r = await upload(port, 32 * MB, false);
      await sleep(50);
      const read = sockets.reduce((n, s) => n + s.bytesRead, 0);
      await srv.shutdown();
      // Before the fix readBody threw inside `for await`, which destroyed the request and with it the
      // socket: the client saw ECONNRESET (and typically retries) instead of a 413.
      assert.deepEqual(
        { status: r.status ?? r.error, bounded: read < 8 * MB },
        { status: 413, bounded: true },
        `server read ${(read / MB).toFixed(1)} MB of a 32 MB upload`,
      );
    });

    it('a declared Content-Length over the limit is rejected without draining the body', async () => {
      const { srv, sockets, port } = await start();
      const r = await upload(port, 32 * MB, true);
      await sleep(50);
      const read = sockets.reduce((n, s) => n + s.bytesRead, 0);
      await srv.shutdown();
      // Before the fix the client got a connection reset instead of the 413.
      assert.deepEqual(
        { status: r.status ?? r.error, bounded: read < 8 * MB },
        { status: 413, bounded: true },
        `server read ${(read / MB).toFixed(1)} MB of a 32 MB upload`,
      );
    });
  });
});

describe('hardening, round 2', () => {
  it('llm-observability: huge prompts are bounded in span attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const tracer = provider.getTracer('t');
    const big = 'context '.repeat(30_000); // 240 KB of RAG context
    await tracing.withLlmSpan(tracer, { provider: 'p', model: 'm', tenantId: 't', messages: [{ role: 'user', content: big }] }, async () => ({ content: big }));
    const attrs = exporter.getFinishedSpans()[0].attributes;
    for (const key of [tracing.ATTR.inputMessages, tracing.ATTR.outputMessages]) {
      const v = String(attrs[key]);
      assert.ok(v.length <= 32 * 1024 + 64, `${key} is ${v.length} chars`);
      assert.match(v, /TRUNCATED \d+ chars/);
    }
    await provider.shutdown();
  });

  it('webhook-ingestion: retention deletes old processed rows in batches, never dead letters', async () => {
    const pool = new pg.Pool({ connectionString: await freshDatabase('kit_inbox_prune') });
    try {
      await runSqlFile(pool, 'webhook-ingestion', 'inbox.sql');
      await pool.query(`
        INSERT INTO webhook_inbox (provider, event_id, event_type, payload, status, processed_at) VALUES
          ('stripe', 'old_done', 't', '{}', 'done', now() - interval '40 days'),
          ('stripe', 'new_done', 't', '{}', 'done', now() - interval '1 day'),
          ('stripe', 'old_dead', 't', '{}', 'dead', NULL);
        INSERT INTO webhook_inbox (provider, event_id, event_type, payload, status, processed_at)
          SELECT 'stripe', 'bulk_' || g, 't', '{}', 'done', now() - interval '60 days' FROM generate_series(1, 2500) g;`);
      const prune = (webhooks as Record<string, unknown>).pruneInbox as undefined | ((p: pg.Pool, o: object) => Promise<number>);
      assert.equal(typeof prune, 'function', 'pruneInbox exists');
      assert.equal(await prune!(pool, { olderThanDays: 30, batchSize: 1000 }), 2501);
      const left = (await pool.query(`SELECT event_id FROM webhook_inbox ORDER BY event_id`)).rows.map((r) => r.event_id);
      assert.deepEqual(left, ['new_done', 'old_dead']);
    } finally {
      await pool.end();
    }
  });

  it('llm-gateway: expired cache entries are pruned', async () => {
    const pool = new pg.Pool({ connectionString: await freshDatabase('kit_llmcache_prune') });
    try {
      await runSqlFile(pool, 'llm-gateway', 'semantic-cache.sql');
      await pool.query(`
        INSERT INTO llm_exact_cache (key, value, expires_at) VALUES ('old', '{}', now() - interval '1 hour'), ('fresh', '{}', now() + interval '1 hour');
        INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at)
          SELECT 's', array_fill(0.1::real, ARRAY[1536])::vector, '{}', now() + make_interval(hours => g * 2 - 3) FROM generate_series(1, 3) g;`);
      const prune = (stores as Record<string, unknown>).pruneLlmCache as undefined | ((p: pg.Pool) => Promise<{ exact: number; semantic: number }>);
      assert.equal(typeof prune, 'function', 'pruneLlmCache exists');
      assert.deepEqual(await prune!(pool), { exact: 1, semantic: 1 });
    } finally {
      await pool.end();
    }
  });
});
