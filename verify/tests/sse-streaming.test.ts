import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sleep } from './helpers.ts';
import { createReplayBuffer, openSse, serveFeed, streamTokens } from '../../skills/sse-streaming/references/sse.ts';

let server: http.Server;
let base: string;
const feed = createReplayBuffer<{ orders: number }>(3);
const probe = { upstreamStopped: false, upstreamSawAbort: false, maxBuffered: 0, trySendRefused: false };

async function* fakeLlm(tokens: string[] | 'forever', delayMs: number, signal?: AbortSignal) {
  try {
    for (let i = 0; tokens === 'forever' || i < tokens.length; i++) {
      await sleep(delayMs);
      if (signal?.aborted) {
        probe.upstreamSawAbort = true;
        return;
      }
      yield tokens === 'forever' ? `t${i} ` : tokens[i];
    }
  } finally {
    probe.upstreamStopped = true;
  }
}

/** Minimal SSE client: collects events until `stopAfter` events or the stream ends. */
async function collect(path: string, opts: { headers?: Record<string, string>; stopAfter?: number; raw?: boolean } = {}) {
  const ac = new AbortController();
  const res = await fetch(base + path, { headers: opts.headers, signal: ac.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const events: Array<{ id?: string; event?: string; data?: string; comment?: string }> = [];
  try {
    while (opts.stopAfter === undefined || events.filter((e) => !e.comment).length < opts.stopAfter) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const e: any = {};
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) e.comment = line.slice(1).trim();
          else {
            const [k, ...rest] = line.split(': ');
            const v = rest.join(': ');
            if (k === 'data') e.data = e.data === undefined ? v : `${e.data}\n${v}`;
            else if (k === 'id' || k === 'event') e[k] = v;
          }
        }
        if (Object.keys(e).length && !('retry' in e)) events.push(e);
      }
    }
  } finally {
    ac.abort();
  }
  return { res, events };
}

describe('sse-streaming', () => {
  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/tokens') {
        const sse = openSse(req, res);
        await streamTokens(sse, fakeLlm(['Xin', ' chào', '\nbạn'], 10, sse.signal));
      } else if (url.pathname === '/tokens-forever') {
        probe.upstreamStopped = false;
        const sse = openSse(req, res);
        await streamTokens(sse, fakeLlm('forever', 30, sse.signal));
      } else if (url.pathname === '/feed') {
        await serveFeed(openSse(req, res, { heartbeatMs: 40 }), feed);
      } else if (url.pathname === '/flood') {
        const sse = openSse(req, res, { maxBufferedBytes: 128 * 1024 });
        const chunk = 'x'.repeat(64 * 1024);
        for (let i = 0; i < 2000 && !sse.closed; i++) {
          if (!sse.trySend({ event: 'tick', data: chunk })) {
            probe.trySendRefused = true;
            break;
          }
          probe.maxBuffered = Math.max(probe.maxBuffered, sse.bufferedBytes());
          await new Promise((r) => setImmediate(r));
        }
        sse.close();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('streams tokens with correct headers, multi-line data, and a done event', async () => {
    const { res, events } = await collect('/tokens');
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    assert.deepEqual(events.map((e) => [e.event, e.data]), [
      ['token', 'Xin'],
      ['token', ' chào'],
      ['token', '\nbạn'],
      ['done', '{"tokens":3}'],
    ]);
  });

  it('client disconnect stops the upstream generator (no tokens generated for nobody)', async () => {
    await collect('/tokens-forever', { stopAfter: 2 });
    for (let i = 0; i < 20 && !probe.upstreamStopped; i++) await sleep(25);
    assert.equal(probe.upstreamStopped, true);
  });

  it('reconnect with Last-Event-ID replays exactly what was missed, then follows live', async () => {
    const seen = feed.append({ orders: 1 }, 'stats'); // the client got this one before it dropped
    const missed = feed.append({ orders: 2 }, 'stats');
    const live = collect('/feed', { headers: { 'last-event-id': String(seen) }, stopAfter: 2 });
    await sleep(50);
    const published = feed.append({ orders: 3 }, 'stats'); // published while connected
    const { events } = await live;
    assert.deepEqual(events.filter((e) => !e.comment).map((e) => e.id), [String(missed), String(published)]);
  });

  it('a client too far behind gets a reset instead of a silent gap', async () => {
    const evicted = feed.append({ orders: 9 }, 'stats');
    for (let i = 0; i < 5; i++) feed.append({ orders: 10 + i }, 'stats'); // capacity 3 → `evicted` is gone
    const { events } = await collect('/feed', { headers: { 'last-event-id': String(evicted) }, stopAfter: 1 });
    assert.equal(events.find((e) => !e.comment)!.event, 'reset');
  });

  it('sends heartbeats so proxies keep the connection open', async () => {
    const pending = collect('/feed', { stopAfter: 1 });
    await sleep(120);
    feed.append({ orders: 99 }, 'stats');
    const { events } = await pending;
    assert.ok(events.some((e) => e.comment === 'ping'));
  });

  it('lossy sends are refused once a slow client lets the buffer fill — memory stays bounded', async () => {
    await new Promise<void>((resolve) => {
      const req = http.get(`${base}/flood`, (res) => {
        res.pause(); // never read: a stalled client
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 500);
      });
      req.on('error', () => {});
    });
    assert.equal(probe.trySendRefused, true);
    assert.ok(probe.maxBuffered <= 128 * 1024 + 70 * 1024, `buffered ${probe.maxBuffered} bytes`);
  });
});
