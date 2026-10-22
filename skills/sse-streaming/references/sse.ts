// Server-Sent Events for LLM tokens and live updates, on plain node:http.
// Covers: correct headers, heartbeats, reconnect with Last-Event-ID replay, backpressure
// (lossless `send` waits for drain; lossy `trySend` refuses when the client is slow),
// and cancellation of upstream work when the client goes away.
import type http from 'node:http';
import { callHook } from './hooks.ts';

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
  /**
   * The stream closes, cleanly, when this aborts. Pass the server's shutdown signal (service-hardening's
   * `ctx.shuttingDown`) for streams that never end on their own, such as feeds: a deploy then ends them, and their
   * browsers reconnect to an instance that stays, instead of the deploy waiting out its grace period.
   */
  closeOn?: AbortSignal;
}

/** The line breaks of the event-stream format: CRLF, LF, and a lone CR. */
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * A field value that can't open a new field. An id or an event name with a line break would let content write its
 * own `id:` (which the browser then sends back as Last-Event-ID) or `event:` lines.
 */
function fieldValue(value: string | number, field: 'id' | 'event'): string {
  const s = String(value);
  if (/[\r\n]/.test(s) || (field === 'id' && s.includes('\u0000'))) throw new TypeError(`sse: the ${field} must not contain a line break${field === 'id' ? ' or a NUL' : ''}`);
  return s;
}

/** One event in the event-stream format, as SseStream writes it. For a framework that writes the response itself. */
export function formatEvent(e: SseEvent): string {
  let out = '';
  if (e.id !== undefined) out += `id: ${fieldValue(e.id, 'id')}\n`;
  if (e.event) out += `event: ${fieldValue(e.event, 'event')}\n`;
  // JSON.stringify(undefined) is undefined: an event without data gets an empty data field, which the browser delivers.
  const data = typeof e.data === 'string' ? e.data : (JSON.stringify(e.data) ?? '');
  // One data field per line. A lone CR counts as a line break for the browser too: split on it as well, or text
  // after it is parsed as a field of its own ("hello\rid: 999" would set the last event id).
  for (const line of data.split(LINE_BREAK)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** One open event stream. Closing it (or the client leaving) aborts `signal`: pass that to upstream work. */
export class SseStream {
  /** Aborted when the stream closes: cancels upstream LLM calls and subscriptions. */
  readonly signal: AbortSignal;
  /** The client's Last-Event-ID header when it reconnects. */
  readonly lastEventId: string | undefined;
  readonly #res: http.ServerResponse;
  readonly #maxBuffered: number;
  readonly #opened = performance.now();
  readonly #ac = new AbortController();
  readonly #heartbeat: NodeJS.Timeout;
  readonly #closeOn?: AbortSignal;
  readonly #onCloseOn = () => this.close();
  #firstEventAt: number | null = null;
  #closed = false;

  constructor(req: http.IncomingMessage, res: http.ServerResponse, opts: SseOptions = {}) {
    // Checked before anything is written. From an unset environment variable these are NaN: a heartbeat every
    // millisecond, and a buffer limit that never refuses (`length > NaN` is never true).
    const heartbeatMs = opts.heartbeatMs ?? 15_000;
    const retryMs = opts.retryMs ?? 3000;
    const maxBuffered = opts.maxBufferedBytes ?? 256 * 1024;
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1) throw new RangeError(`sse: heartbeatMs must be a positive integer, got ${heartbeatMs}`);
    if (!Number.isInteger(retryMs) || retryMs < 0) throw new RangeError(`sse: retryMs must be an integer of 0 or more, got ${retryMs}`);
    if (!(maxBuffered > 0) || !Number.isFinite(maxBuffered)) throw new RangeError(`sse: maxBufferedBytes must be a positive number, got ${maxBuffered}`);
    this.#res = res;
    this.#maxBuffered = maxBuffered;
    this.#closeOn = opts.closeOn;
    this.signal = this.#ac.signal;
    this.lastEventId = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform', // no-transform: stop proxies from gzipping/buffering
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: don't buffer
    });
    res.write(`retry: ${retryMs}\n\n`);
    this.#heartbeat = setInterval(() => {
      if (!this.#closed) res.write(': ping\n\n');
    }, heartbeatMs);
    this.#heartbeat.unref();
    const close = () => this.close();
    req.on('close', close);
    res.on('close', close);
    res.on('error', close);
    if (this.#closeOn?.aborted) this.close();
    else this.#closeOn?.addEventListener('abort', this.#onCloseOn, { once: true });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Lossless: resolves once the socket can take more (backpressure propagates upstream). false = client gone. */
  async send(e: SseEvent): Promise<boolean> {
    if (this.#closed) return false;
    this.#firstEventAt ??= performance.now();
    if (!this.#res.write(formatEvent(e))) await this.#drainOrClose();
    return !this.#closed;
  }

  /** Lossy: for dashboards — if the client is behind, skip this update (send the latest state later). */
  trySend(e: SseEvent): boolean {
    if (this.#closed || this.#res.writableLength > this.#maxBuffered) return false;
    this.#firstEventAt ??= performance.now();
    this.#res.write(formatEvent(e));
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#finish(new Error('sse closed'));
    if (!this.#res.writableEnded) this.#res.end();
  }

  /** Drop the connection now (no graceful end): for clients that stopped reading. */
  abort(): void {
    if (!this.#closed) this.#finish(new Error('sse aborted'));
    this.#res.destroy();
  }

  /** Time to first event since the stream opened (TTFT for token streams). */
  ttfbMs(): number | null {
    return this.#firstEventAt === null ? null : this.#firstEventAt - this.#opened;
  }

  bufferedBytes(): number {
    return this.#res.writableLength;
  }

  /** Marks the stream closed, stops its timers and listeners, and cancels upstream work. */
  #finish(reason: Error) {
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#closeOn?.removeEventListener('abort', this.#onCloseOn);
    this.#ac.abort(reason);
  }

  #drainOrClose(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.#res.off('drain', done);
        this.#res.off('close', done);
        resolve();
      };
      this.#res.once('drain', done);
      this.#res.once('close', done);
    });
  }
}

export const openSse = (req: http.IncomingMessage, res: http.ServerResponse, opts: SseOptions = {}) => new SseStream(req, res, opts);

/**
 * Stream LLM tokens. Pass `sse.signal` into the model call as well, so a disconnect stops generation (and billing)
 * at the provider, not just our loop. The stream ends with one event the client acts on (and then closes its
 * EventSource, which would otherwise reconnect and ask again): `done` with the token count, or `failed` when the model
 * call fails partway. That error is rethrown for the app to log. A model call that throws because the client left is
 * how a stream ends, not a failure.
 */
export async function streamTokens(sse: SseStream, tokens: AsyncIterable<string>) {
  let n = 0;
  try {
    for await (const t of tokens) {
      if (!(await sse.send({ event: 'token', data: t }))) break; // `break` runs the generator's finally
      n++;
    }
  } catch (err) {
    if (!sse.closed) {
      // In band, then a clean end: to the client a dropped connection looks like a network error, not a failed answer.
      await sse.send({ event: 'failed', data: { tokens: n } });
      sse.close();
      throw err;
    }
  }
  if (!sse.closed) {
    await sse.send({ event: 'done', data: { tokens: n } });
    sse.close();
  }
  return { tokens: n, ttftMs: sse.ttfbMs() };
}

export interface ReplayItem<T> {
  id: number;
  event?: string;
  data: T;
}

/**
 * Bounded in-memory replay log for one channel (e.g. one tenant's dashboard feed).
 * Single instance only — with several app instances use Redis Streams (XADD / XRANGE by id)
 * or Postgres as the log, and pub/sub (Redis, LISTEN/NOTIFY) for the live fan-out.
 */
export class ReplayBuffer<T> {
  readonly #capacity: number;
  readonly #items: Array<ReplayItem<T>> = [];
  readonly #listeners = new Set<(e: ReplayItem<T>) => void>();
  #seq: number;

  constructor(capacity = 1000, now: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('replay buffer: capacity must be a positive integer');
    this.#capacity = capacity;
    // Ids start from the clock (milliseconds × 1000) rather than from 1, so they keep increasing across restarts:
    // a Last-Event-ID from before a deploy is older than anything this process has and gets a 'reset', instead of
    // the new process's events that happen to reuse its numbers. Exact while a process averages < 1,000 events/ms.
    this.#seq = now() * 1000;
  }

  append(data: T, event?: string): number {
    const item = { id: ++this.#seq, event, data };
    this.#items.push(item);
    if (this.#items.length > this.#capacity) this.#items.shift();
    // One subscriber that throws must not keep the event from the others, nor fail the publisher.
    for (const l of this.#listeners) callHook(l, item);
    return item.id;
  }

  /** Events after lastEventId, or 'reset' if this buffer can't tell what the client missed (it must re-fetch full state). */
  since(lastEventId: string | undefined): Array<ReplayItem<T>> | 'reset' {
    if (lastEventId === undefined) return [];
    const last = Number(lastEventId);
    if (!Number.isSafeInteger(last) || last < 0 || last > this.#seq) return 'reset';
    const oldest = this.#items[0]?.id ?? this.#seq + 1;
    if (last < oldest - 1) return 'reset'; // evicted, or from before this process started
    return this.#items.filter((i) => i.id > last);
  }

  /** `fn` runs inside append(), for every event; whatever it throws is dropped. Returns the unsubscribe function. */
  subscribe(fn: (e: ReplayItem<T>) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

export const createReplayBuffer = <T>(capacity = 1000) => new ReplayBuffer<T>(capacity);

export interface FeedOptions {
  /**
   * Events allowed to wait for one client (default 1000, the replay buffer's default capacity). A client
   * further behind than that can't be replayed anyway, so it is dropped: EventSource reconnects with
   * Last-Event-ID and gets the replay — or a 'reset' to reload state — instead of this process holding
   * its backlog in memory until TCP notices a dead peer (which can take hours).
   */
  maxQueue?: number;
  onOverflow?: () => unknown; // metric / log hook
}

/** Replay what the client missed, then follow live events until it disconnects. */
export async function serveFeed<T>(sse: SseStream, feed: ReplayBuffer<T>, opts: FeedOptions = {}) {
  const maxQueue = opts.maxQueue ?? 1000;
  // NaN (an unset environment variable) would never drop a stalled client: its queue would grow without bound.
  if (!Number.isInteger(maxQueue) || maxQueue < 1) throw new RangeError(`serveFeed: maxQueue must be a positive integer, got ${maxQueue}`);
  // Subscribe first, replay second, dedup by id: nothing published during replay is lost.
  const queue: Array<ReplayItem<T>> = [];
  let wake: (() => void) | null = null;
  const unsubscribe = feed.subscribe((e) => {
    if (sse.closed) return;
    queue.push(e);
    if (queue.length > maxQueue) {
      queue.length = 0;
      sse.abort();
      callHook(opts.onOverflow);
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
