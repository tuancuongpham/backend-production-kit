// Journey: a customer asks the support assistant about her order, then follows the order live. What browsers and
// networks do to an event stream: read the whole answer, close the tab halfway, lose the connection and reconnect
// with Last-Event-ID, reconnect across a deploy, send a Last-Event-ID nobody issued; and what models do: fail
// halfway. Every stream is read as the browser reads it (support/sse-parser.ts).
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor } from '../support/wait.ts';
import { EventStreamTab } from '../support/event-stream-tab.ts';
import { sendJson } from '../support/http.ts';
import { createHardenedServer } from '../../../skills/service-hardening/references/server.ts';
import { createReplayBuffer, openSse, serveFeed, streamTokens, type ReplayBuffer } from '../../../skills/sse-streaming/references/sse.ts';

/** The assistant's answer, token by token as a provider streams it: Vietnamese, an emoji, a paragraph break. */
const ANSWER = ['Chào chị Lan! ', 'Đơn ', 'o-1024 ', 'đang ', 'được ', 'giao 🚚', '\n\n', 'Dự kiến ', 'thứ Sáu.'];
const ASK = `/v1/assistant?q=${encodeURIComponent('Đơn o-1024 của tôi đâu rồi?')}`;
const FEED = '/v1/orders/o-1024/events';

/** The provider's side: calls still running (and billing), tokens generated, and a failure to inject. */
const provider = { open: 0, generated: 0, tokenMs: 1, failAfter: Infinity };

/** Stands in for a provider SDK's stream. Like real SDKs, it throws once the abort signal fires. */
async function* askModel(signal: AbortSignal): AsyncGenerator<string> {
  provider.open++;
  try {
    for (const token of ANSWER) {
      await delay(provider.tokenMs, undefined, { signal });
      if (provider.generated >= provider.failAfter) throw new Error('provider: 529 overloaded');
      provider.generated++;
      yield token;
    }
  } finally {
    provider.open--;
  }
}

type OrderUpdate = { orderId: string; status: string };
const update = (status: string): OrderUpdate => ({ orderId: 'o-1024', status });
const statuses = (events: Array<{ data: string }>) => events.map((e) => (JSON.parse(e.data) as OrderUpdate).status);

/** The order feed's replay store. Instances share it, as they would share Redis Streams. */
let feed: ReplayBuffer<OrderUpdate>;

interface App {
  port: number;
  logs: string[];
  shutdown(): Promise<{ forced: boolean }>;
  stats(): { inFlight: number; draining: boolean };
}
const running: App[] = [];

async function startApp(o: { drainMs?: number; graceMs?: number } = {}): Promise<App> {
  const logs: string[] = [];
  const app = createHardenedServer({
    drainDelayMs: o.drainMs ?? 0,
    shutdownGraceMs: o.graceMs ?? 2_000,
    log: (msg, extra) => void logs.push(`${msg} ${JSON.stringify(extra ?? {})}`),
    handler: async (req, res, ctx) => {
      const path = new URL(req.url ?? '/', 'http://shop').pathname;
      if (path === '/v1/assistant') {
        const sse = openSse(req, res, { retryMs: 2000 });
        await streamTokens(sse, askModel(sse.signal)); // the signal reaches the provider: a closed tab stops the bill
        return;
      }
      // A feed never ends on its own: it ends when the server shuts down, so its browser reconnects elsewhere.
      if (path === FEED) return serveFeed(openSse(req, res, { heartbeatMs: 1000, closeOn: ctx.shuttingDown }), feed);
      sendJson(res, 404, { error: 'not_found' });
    },
  });
  const instance = { port: await app.listen(0, '127.0.0.1'), logs, shutdown: app.shutdown, stats: app.stats };
  running.push(instance);
  return instance;
}

const failures = (app: App) => app.logs.filter((line) => line.startsWith('request failed'));

describe('journey: a customer asks the assistant, then follows her order live', () => {
  beforeEach(() => {
    Object.assign(provider, { open: 0, generated: 0, tokenMs: 1, failAfter: Infinity });
    feed = createReplayBuffer<OrderUpdate>();
  });
  afterEach(async () => {
    await Promise.all(running.splice(0).map((app) => app.shutdown()));
  });
  after(() => assert.equal(provider.open, 0, 'no model call left running'));

  it('Lan asks where her order is and reads the whole answer as it is written, then done', async () => {
    const app = await startApp();
    const tab = new EventStreamTab(app.port, ASK);
    const res = await tab.response;
    assert.deepEqual(
      [res.statusCode, res.headers['content-type'], res.headers['cache-control']],
      [200, 'text/event-stream; charset=utf-8', 'no-cache, no-transform'],
    );
    await tab.ended;
    const { events, retryMs } = tab.stream;
    assert.equal(retryMs, 2000);
    assert.equal(events.filter((e) => e.type === 'token').map((e) => e.data).join(''), ANSWER.join(''));
    assert.deepEqual(events.at(-1), { type: 'done', data: JSON.stringify({ tokens: ANSWER.length }), lastEventId: '' });
  });

  it('she closes the tab after the first words: the model call is cancelled, and that is not an error', async () => {
    provider.tokenMs = 25;
    const app = await startApp();
    const tab = new EventStreamTab(app.port, ASK);
    await tab.events(2, 'the first words');
    tab.close();
    await waitFor(() => provider.open === 0, 'the model call to be cancelled');
    assert.ok(provider.generated < ANSWER.length, `${provider.generated} of ${ANSWER.length} tokens generated`);
    await waitFor(() => app.stats().inFlight === 0, 'the request to finish');
    assert.deepEqual(failures(app), []);
  });

  it('the model fails halfway: she keeps the words so far and gets a failed event, not a dropped connection', async () => {
    provider.failAfter = 3;
    const app = await startApp();
    const tab = new EventStreamTab(app.port, ASK);
    await tab.ended;
    const { events } = tab.stream;
    assert.deepEqual(
      events.map((e) => e.type),
      ['token', 'token', 'token', 'failed'],
    );
    assert.deepEqual(JSON.parse(events.at(-1)!.data), { tokens: 3 });
    await waitFor(() => app.stats().inFlight === 0, 'the request to finish');
    assert.equal(failures(app).length, 1, 'the app still logs the failure');
  });

  it('her train enters a tunnel: the feed reconnects with Last-Event-ID and gets what it missed once, in order, then live', async () => {
    const app = await startApp();
    const tab = new EventStreamTab(app.port, FEED);
    await tab.response;
    feed.append(update('đã thanh toán'), 'order.updated');
    feed.append(update('đã đóng gói'), 'order.updated');
    await tab.events(2);
    tab.close(); // the tunnel
    feed.append(update('đang giao'), 'order.updated'); // while she is offline
    feed.append(update('giao trễ: kẹt xe 🚦'), 'order.updated');
    const back = new EventStreamTab(app.port, FEED, { 'last-event-id': tab.stream.lastEventId });
    await back.events(2, 'the updates she missed');
    feed.append(update('đã giao'), 'order.updated');
    const events = await back.events(3, 'the live update');
    back.close();
    assert.deepEqual(statuses(events), ['đang giao', 'giao trễ: kẹt xe 🚦', 'đã giao']);
    assert.deepEqual(new Set(events.map((e) => e.type)), new Set(['order.updated']));
  });

  it('a deploy while she follows her order: the stream ends once traffic has moved, and she resumes on the new instance', async () => {
    const old = await startApp({ drainMs: 50, graceMs: 5_000 });
    const next = await startApp();
    const tab = new EventStreamTab(old.port, FEED);
    await tab.response;
    feed.append(update('đã đóng gói'), 'order.updated');
    await tab.events(1);
    const startedAt = performance.now();
    const deploy = old.shutdown();
    await tab.ended;
    const endedAfter = performance.now() - startedAt;
    assert.ok(endedAfter >= 45, `ended after ${endedAfter} ms: not before the load balancer stopped sending traffic here`);
    assert.deepEqual(await deploy, { forced: false });
    assert.ok(performance.now() - startedAt < 2_000, 'without waiting out the grace period');
    feed.append(update('đang giao'), 'order.updated');
    const back = new EventStreamTab(next.port, FEED, { 'last-event-id': tab.stream.lastEventId });
    assert.deepEqual(statuses(await back.events(1, 'the update after the deploy')), ['đang giao']);
    back.close();
  });

  it('she comes back with a Last-Event-ID from the old process: told to reload, not a silent gap', async () => {
    const app = await startApp();
    const tab = new EventStreamTab(app.port, FEED);
    await tab.response;
    feed.append(update('đã thanh toán'), 'order.updated');
    await tab.events(1);
    tab.close();
    await delay(2);
    feed = createReplayBuffer<OrderUpdate>(); // a restart that lost the in-memory history
    feed.append(update('đã giao'), 'order.updated');
    const back = new EventStreamTab(app.port, FEED, { 'last-event-id': tab.stream.lastEventId });
    const [first] = await back.events(1);
    back.close();
    assert.equal(first.type, 'reset');
  });

  it('a Last-Event-ID nobody issued (edited, garbage, from the future) gets reset, never a crash or a wrong replay', async () => {
    const app = await startApp();
    feed.append(update('đã thanh toán'), 'order.updated');
    for (const id of ['abc', '-1', '12.5', '0x10', '1e309', '99999999999999999999999', String(Number.MAX_SAFE_INTEGER)]) {
      const tab = new EventStreamTab(app.port, FEED, { 'last-event-id': id });
      const [first] = await tab.events(1, `the answer to Last-Event-ID ${id}`);
      tab.close();
      assert.equal(first.type, 'reset', id);
    }
    await waitFor(() => app.stats().inFlight === 0, 'every stream to close');
    assert.deepEqual(failures(app), []);
  });
});
