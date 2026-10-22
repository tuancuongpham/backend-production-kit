import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { sleep, waitFor } from '../support/wait.ts';
import { createHardenedServer, deadline, installSignalHandlers, readBody } from '../../../skills/service-hardening/references/server.ts';

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
  it('graceful shutdown: in-flight requests finish, readiness fails, the drain still answers, then the listener closes', async () => {
    const { srv } = app();
    const port = await srv.listen();
    const base = `http://127.0.0.1:${port}`;
    const inflight = [1, 2, 3].map(() => fetch(`${base}/slow?ms=400`).then(async (r) => [r.status, await r.text()]));
    await sleep(50);
    const done = srv.shutdown();
    await sleep(20);
    assert.equal((await fetch(`${base}/readyz`)).status, 503, 'readiness flips first');
    const late = await fetch(`${base}/fast`);
    assert.deepEqual([late.status, late.headers.get('connection'), await late.text()], [200, 'close', 'fast'], 'what the load balancer still sends is answered');
    assert.deepEqual(await Promise.all(inflight), [[200, 'slow done'], [200, 'slow done'], [200, 'slow done']]);
    assert.deepEqual(await done, { forced: false });
    await assert.rejects(fetch(`${base}/livez`), 'listener closed after shutdown');
  });

  it('ctx.shuttingDown fires once traffic has moved (after the drain delay), so long-lived responses end then', async () => {
    let endedAt = 0;
    const srv = createHardenedServer({
      drainDelayMs: 100,
      shutdownGraceMs: 2000,
      handler: async (_req, res, ctx) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).write(': open\n\n');
        await new Promise<void>((resolve) => ctx.shuttingDown.addEventListener('abort', () => resolve(), { once: true }));
        endedAt = performance.now();
        res.end(); // a feed's browser now reconnects, to an instance the load balancer still sends traffic to
      },
    });
    const port = await srv.listen();
    const feed = fetch(`http://127.0.0.1:${port}/feed`).then((r) => r.text());
    await sleep(30);
    const startedAt = performance.now();
    const done = srv.shutdown();
    await sleep(50);
    assert.equal(endedAt, 0, 'not during the drain delay: its reconnect would come back here, only to be ended again');
    assert.equal(await feed, ': open\n\n');
    assert.ok(endedAt - startedAt >= 95, `ended ${endedAt - startedAt} ms into the shutdown`);
    assert.deepEqual(await done, { forced: false }, 'without waiting out the grace period');
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

  it('a client that disconnects mid-upload fails readBody at once, instead of leaving the handler waiting', async () => {
    let failure: Error | undefined;
    const srv = createHardenedServer({
      drainDelayMs: 0,
      handler: async (req, res) => {
        try {
          await readBody(req, 1024 * 1024);
          res.end('ok');
        } catch (err) {
          failure = err as Error;
        }
      },
    });
    const port = await srv.listen();
    const upload = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/upload', headers: { 'content-length': '100000' } });
    upload.on('error', () => {});
    upload.write('x'.repeat(1000));
    await waitFor(() => srv.stats().inFlight === 1, 'the upload to start');
    upload.destroy(); // the phone lost its signal
    await waitFor(() => failure !== undefined, 'the read to fail');
    assert.match(failure!.message, /aborted/);
    await srv.shutdown();
  });

  it('deadline(ms, ctx.signal) aborts at the deadline or when the client leaves, whichever comes first', async () => {
    const client = new AbortController();
    const early = deadline(10_000, client.signal);
    client.abort(new Error('client disconnected'));
    assert.equal(early.aborted, true);
    const late = deadline(20, new AbortController().signal);
    await sleep(60);
    assert.equal(late.aborted, true);
  });

  describe('installSignalHandlers', () => {
    // process.emit runs the handlers without a real signal. The listeners they add are removed afterwards.
    type Listener = (...args: unknown[]) => void;
    const events = ['SIGTERM', 'SIGINT', 'unhandledRejection'];
    const listenersOf = (event: string) => process.listeners(event as 'SIGTERM') as Listener[];
    const withHandlers = async (shutdown: () => Promise<unknown>, body: (exits: number[]) => Promise<void>) => {
      const before = new Map(events.map((e) => [e, new Set(listenersOf(e))]));
      const exits: number[] = [];
      installSignalHandlers(shutdown, (code) => void exits.push(code));
      try {
        await body(exits);
      } finally {
        for (const e of events) for (const l of listenersOf(e)) if (!before.get(e)!.has(l)) process.off(e as 'SIGTERM', l);
      }
    };

    it('SIGTERM shuts down gracefully, then exits 0', async () => {
      await withHandlers(
        () => sleep(20),
        async (exits) => {
          process.emit('SIGTERM');
          assert.deepEqual(exits, [], 'not before the in-flight work is done');
          await sleep(60);
          assert.deepEqual(exits, [0]);
        },
      );
    });

    it('a second signal while shutting down exits 1 at once (an operator pressing Ctrl+C again)', async () => {
      await withHandlers(
        () => new Promise(() => {}),
        async (exits) => {
          process.emit('SIGTERM');
          process.emit('SIGINT');
          assert.deepEqual(exits, [1]);
        },
      );
    });

    it('a shutdown that fails exits 1', async () => {
      await withHandlers(
        () => Promise.reject(new Error('a hook hung up')),
        async (exits) => {
          process.emit('SIGTERM');
          await sleep(20);
          assert.deepEqual(exits, [1]);
        },
      );
    });
  });
});
