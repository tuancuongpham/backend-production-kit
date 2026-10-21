// Server-Sent Events for LLM tokens and live updates, on plain node:http.
// Covers: correct headers, heartbeats, reconnect with Last-Event-ID replay, backpressure
// (lossless `send` waits for drain; lossy `trySend` refuses when the client is slow),
// and cancellation of upstream work when the client goes away.
import type http from 'node:http';

export interface SseEvent {
  id?: string | number;
  event?: string;
  data: unknown; // strings are sent as-is, everything else as JSON
}

export interface SseOptions {
  heartbeatMs?: number; // default 15s — below typical proxy idle timeouts (often 30–60s)
  retryMs?: number; // client reconnect delay hint, default 3s
  /** Lossy sends are refused once this much is queued for the socket. */
  maxBufferedBytes?: number; // default 256 KiB
}

export type SseStream = ReturnType<typeof openSse>;

function format(e: SseEvent): string {
  let out = '';
  if (e.id !== undefined) out += `id: ${e.id}\n`;
  if (e.event) out += `event: ${e.event}\n`;
  const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
  for (const line of data.split('\n')) out += `data: ${line}\n`; // multi-line data needs one field per line
  return `${out}\n`;
}

export function openSse(req: http.IncomingMessage, res: http.ServerResponse, opts: SseOptions = {}) {
  const maxBuffered = opts.maxBufferedBytes ?? 256 * 1024;
  const opened = performance.now();
  let firstEventAt: number | null = null;
  let closed = false;
  const ac = new AbortController();

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform', // no-transform: stop proxies from gzipping/buffering
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // nginx: don't buffer
  });
  res.write(`retry: ${opts.retryMs ?? 3000}\n\n`);

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, opts.heartbeatMs ?? 15_000);
  heartbeat.unref();

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    ac.abort(new Error('sse closed')); // cancels upstream LLM calls / subscriptions
    if (!res.writableEnded) res.end();
  }
  /** Drop the connection now (no graceful end): for clients that stopped reading. */
  function abort() {
    if (!closed) {
      closed = true;
      clearInterval(heartbeat);
      ac.abort(new Error('sse aborted'));
    }
    res.destroy();
  }
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);

  const waitForDrainOrClose = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
    });

  /** Lossless: resolves once the socket can take more (backpressure propagates upstream). false = client gone. */
  async function send(e: SseEvent): Promise<boolean> {
    if (closed) return false;
    firstEventAt ??= performance.now();
    if (!res.write(format(e))) await waitForDrainOrClose();
    return !closed;
  }

  /** Lossy: for dashboards — if the client is behind, skip this update (send the latest state later). */
  function trySend(e: SseEvent): boolean {
    if (closed || res.writableLength > maxBuffered) return false;
    firstEventAt ??= performance.now();
    res.write(format(e));
    return true;
  }

  return {
    send,
    trySend,
    close,
    abort,
    signal: ac.signal,
    lastEventId: typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined,
    get closed() {
      return closed;
    },
    /** Time to first event since the stream opened (TTFT for token streams). */
    ttfbMs: () => (firstEventAt === null ? null : firstEventAt - opened),
    bufferedBytes: () => res.writableLength,
  };
}

/**
 * Stream LLM tokens. Pass `sse.signal` into the model call as well, so a disconnect stops
 * generation (and billing) at the provider, not just our loop.
 */
export async function streamTokens(sse: SseStream, tokens: AsyncIterable<string>) {
  let n = 0;
  for await (const t of tokens) {
    if (!(await sse.send({ event: 'token', data: t }))) break; // `break` runs the generator's finally
    n++;
  }
  if (!sse.closed) {
    await sse.send({ event: 'done', data: { tokens: n } });
    sse.close();
  }
  return { tokens: n, ttftMs: sse.ttfbMs() };
}

/**
 * Bounded in-memory replay log for one channel (e.g. one tenant's dashboard feed).
 * Single instance only — with several app instances use Redis Streams (XADD / XRANGE by id)
 * or Postgres as the log, and pub/sub (Redis, LISTEN/NOTIFY) for the live fan-out.
 */
export function createReplayBuffer<T>(capacity = 1000) {
  let seq = 0;
  const items: Array<{ id: number; event?: string; data: T }> = [];
  const listeners = new Set<(e: { id: number; event?: string; data: T }) => void>();

  return {
    append(data: T, event?: string) {
      const item = { id: ++seq, event, data };
      items.push(item);
      if (items.length > capacity) items.shift();
      for (const l of listeners) l(item);
      return item.id;
    },
    /** Events after lastEventId, or 'reset' if the client is too far behind (it must re-fetch full state). */
    since(lastEventId: string | undefined) {
      if (lastEventId === undefined) return [];
      const last = Number(lastEventId);
      if (!Number.isInteger(last) || last < 0 || last > seq) return 'reset' as const;
      const oldest = items[0]?.id ?? seq + 1;
      if (last < oldest - 1) return 'reset' as const;
      return items.filter((i) => i.id > last);
    },
    subscribe(fn: (e: { id: number; event?: string; data: T }) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export interface FeedOptions {
  /**
   * Events allowed to wait for one client (default 1000, the replay buffer's default capacity). A client
   * further behind than that can't be replayed anyway, so it is dropped: EventSource reconnects with
   * Last-Event-ID and gets the replay — or a 'reset' to reload state — instead of this process holding
   * its backlog in memory until TCP notices a dead peer (which can take hours).
   */
  maxQueue?: number;
  onOverflow?: () => void; // metric / log hook
}

/** Replay what the client missed, then follow live events until it disconnects. */
export async function serveFeed<T>(sse: SseStream, feed: ReturnType<typeof createReplayBuffer<T>>, opts: FeedOptions = {}) {
  const maxQueue = opts.maxQueue ?? 1000;
  // Subscribe first, replay second, dedup by id: nothing published during replay is lost.
  const queue: Array<{ id: number; event?: string; data: T }> = [];
  let wake: (() => void) | null = null;
  const unsubscribe = feed.subscribe((e) => {
    if (sse.closed) return;
    queue.push(e);
    if (queue.length > maxQueue) {
      queue.length = 0;
      opts.onOverflow?.();
      sse.abort();
      return;
    }
    wake?.();
  });
  sse.signal.addEventListener('abort', () => wake?.());
  try {
    let lastSent = Number(sse.lastEventId ?? 0);
    const missed = feed.since(sse.lastEventId);
    if (missed === 'reset') {
      await sse.send({ event: 'reset', data: { reason: 'history unavailable, reload state' } });
      // The client re-fetches full state after 'reset'; anything queued so far is part of that state.
      queue.length = 0;
      lastSent = 0;
    } else {
      for (const e of missed) {
        await sse.send({ id: e.id, event: e.event, data: e.data });
        lastSent = e.id;
      }
    }
    while (!sse.closed) {
      const e = queue.shift();
      if (!e) {
        await new Promise<void>((r) => (wake = r));
        wake = null;
        continue;
      }
      if (e.id <= lastSent) continue;
      if (!(await sse.send({ id: e.id, event: e.event, data: e.data }))) break;
      lastSent = e.id;
    }
  } finally {
    unsubscribe();
  }
}
