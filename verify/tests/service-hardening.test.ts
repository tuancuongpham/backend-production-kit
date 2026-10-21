import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { sleep } from './helpers.ts';
import { createHardenedServer, readBody } from '../../skills/service-hardening/references/server.ts';

function app(extra: Partial<Parameters<typeof createHardenedServer>[0]> = {}) {
  const aborted: string[] = [];
  const srv = createHardenedServer({
    drainDelayMs: 100,
    shutdownGraceMs: 2000,
    ...extra,
    handler: async (req, res, ctx) => {
      if (req.url?.startsWith('/slow')) {
        const ms = Number(new URL(req.url, 'http://x').searchParams.get('ms') ?? 300);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(t);
            aborted.push(ctx.requestId);
            resolve();
          });
        });
        if (!ctx.signal.aborted) res.end('slow done');
        return;
      }
      if (req.url === '/boom') throw new Error('handler bug');
      if (req.url === '/upload') {
        const body = await readBody(req, 1024);
        return void res.end(`got ${body.length}`);
      }
      res.end('fast');
    },
  });
  return { srv, aborted };
}

describe('service-hardening', () => {
  it('graceful shutdown: in-flight requests finish, readiness fails, new work is refused', async () => {
    const { srv } = app();
    const port = await srv.listen();
    const base = `http://127.0.0.1:${port}`;
    const inflight = [1, 2, 3].map(() => fetch(`${base}/slow?ms=400`).then(async (r) => [r.status, await r.text()]));
    await sleep(50);
    const done = srv.shutdown();
    await sleep(20);
    assert.equal((await fetch(`${base}/readyz`)).status, 503, 'readiness flips first');
    assert.equal((await fetch(`${base}/fast`)).status, 503, 'new work refused while draining');
    assert.deepEqual(await Promise.all(inflight), [[200, 'slow done'], [200, 'slow done'], [200, 'slow done']]);
    assert.deepEqual(await done, { forced: false });
    await assert.rejects(fetch(`${base}/livez`), 'listener closed after shutdown');
  });

  it('grace period bounds shutdown: stragglers are cut off', async () => {
    const hooks: string[] = [];
    const { srv } = app({ drainDelayMs: 10, shutdownGraceMs: 150, onShutdown: [async () => void hooks.push('db pool closed')] });
    const port = await srv.listen();
    const straggler = fetch(`http://127.0.0.1:${port}/slow?ms=5000`).catch((e) => e);
    await sleep(30);
    const t0 = performance.now();
    assert.deepEqual(await srv.shutdown(), { forced: true });
    assert.ok(performance.now() - t0 < 1000);
    assert.ok((await straggler) instanceof Error);
    assert.deepEqual(hooks, ['db pool closed']);
  });

  it('sheds load with fast 503s beyond maxInFlight', async () => {
    const { srv } = app({ maxInFlight: 2 });
    const port = await srv.listen();
    const statuses = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        await sleep(i * 10); // make arrival order deterministic
        const t0 = performance.now();
        const r = await fetch(`http://127.0.0.1:${port}/slow?ms=300`);
        await r.text();
        return [r.status, performance.now() - t0] as const;
      }),
    );
    assert.deepEqual(statuses.map(([s]) => s).sort(), [200, 200, 503, 503, 503]);
    assert.ok(statuses.filter(([s]) => s === 503).every(([, ms]) => ms < 150), 'rejections are immediate');
    await srv.shutdown();
  });

  it('client disconnect aborts the request signal', async () => {
    const { srv, aborted } = app();
    const port = await srv.listen();
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${port}/slow?ms=3000`, { signal: ac.signal, headers: { 'x-request-id': 'req-abc' } }).catch(() => {});
    await sleep(50);
    ac.abort();
    await p;
    await sleep(50);
    assert.deepEqual(aborted, ['req-abc']);
    await srv.shutdown();
  });

  it('handler errors become 500 without killing the server; body limit → 413; request ids', async () => {
    const { srv } = app();
    const port = await srv.listen();
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/boom`)).status, 500);
    assert.equal((await fetch(`${base}/upload`, { method: 'POST', body: 'x'.repeat(2048) })).status, 413);
    assert.equal(await (await fetch(`${base}/upload`, { method: 'POST', body: 'x'.repeat(10) })).text(), 'got 10');
    const r = await fetch(`${base}/fast`, { headers: { 'x-request-id': 'bad id with spaces' } });
    assert.match(r.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/, 'invalid incoming ids are replaced');
    assert.equal((await fetch(`${base}/livez`)).status, 200);
    await srv.shutdown();
  });

  it('readiness reflects dependency checks', async () => {
    let dbUp = false;
    const { srv } = app({ readinessChecks: [async () => { if (!dbUp) throw new Error('db down'); }] });
    const port = await srv.listen();
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/livez`)).status, 200, 'liveness ignores dependencies');
    dbUp = true;
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
    await srv.shutdown();
  });

  it('timeouts are configured', async () => {
    const { srv } = app();
    assert.equal(srv.server.headersTimeout, 10_000);
    assert.equal(srv.server.keepAliveTimeout, 65_000);
    srv.server.listen(0);
    await once(srv.server, 'listening');
    await srv.shutdown();
  });
});
