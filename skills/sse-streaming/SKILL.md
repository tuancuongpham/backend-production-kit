---
name: sse-streaming
description: Stream LLM tokens and live data updates to browsers with Server-Sent Events (or WebSockets when truly bidirectional) — correct headers, heartbeats, reconnect with Last-Event-ID replay, backpressure for slow clients, and cancelling the upstream LLM call when the user leaves. Use whenever the user builds a chat UI, "typing" AI responses, realtime dashboards, progress updates for long jobs, notifications, or mentions SSE, EventSource, WebSocket, Socket.IO, TTFT, "stream response", "realtime", "cập nhật thời gian thực".
---

# Streaming: tokens and live updates

Users judge AI features by **time to first token** and by whether the stream survives a flaky network. The server must also stop paying for tokens nobody will read. SSE covers most of this with plain HTTP: it works through proxies and CDNs, reconnects automatically, and replays via `Last-Event-ID`. Reach for WebSockets only when the client sends a high-frequency stream too (collaborative editing, games, voice).

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| SSE vs WebSocket | SSE | Chat sends one POST and receives a stream back, which is SSE. Bidirectional real-time is WebSocket. |
| Framework helper | Their framework's streaming API (AI SDK `toUIMessageStreamResponse`, Hono `streamSSE`, Fastify reply.raw…) | The reference shows the mechanics; keep the guarantees whichever helper is used. |
| Per-stream semantics | Tokens: **lossless** (backpressure). Dashboards: **lossy** (skip and send latest) | Never drop tokens; never queue unbounded dashboard updates. |
| Replay store (multi-instance) | Redis Streams (`XADD` / `XRANGE`) or Postgres; pub/sub for fan-out | The in-memory buffer only works for a single instance. |
| DB change source | App publishes after commit (outbox) or `LISTEN/NOTIFY` (payload ≤ 8 KB: send ids, not rows) | Authorize the subscription by tenant. A channel name is not access control. |

## Implementation steps

Reference: [references/sse.ts](references/sse.ts), with `hooks.ts`, the kit's shared helper for calling the app's hooks: copy both.

1. **Headers**: `text/event-stream`, `cache-control: no-cache, no-transform` (no-transform stops proxy gzip buffering), `x-accel-buffering: no` (nginx), plus a `retry:` hint. Disable response compression on this route.
2. **Heartbeat**: send a comment line every ~15 s. Idle proxies (often 30–60 s) otherwise cut the stream silently.
   `openSse` refuses a NaN `heartbeatMs` before writing anything: from an unset environment variable it pinged every
   millisecond. A NaN `maxBufferedBytes` (`trySend`) or `maxQueue` (`serveFeed`) is refused too; it never dropped a
   stalled client.
3. **Cancellation**: `openSse()` exposes `signal`, which aborts on client disconnect. Pass it **into the LLM SDK call**, so the provider stops generating. Leaving the loop is not enough, because the provider may still bill the rest. The SDK then throws an `AbortError`; `streamTokens` treats that as the end of the stream, not a failure, so a closed tab isn't logged as a failed request.
4. **Tokens**: `streamTokens(sse, iterable)` uses lossless `send()`, which awaits `drain` when the socket buffer is full. Backpressure propagates to the token iterator, so you never build an unbounded queue. It ends with exactly one event the client acts on:
   - `done`, with the usage, the finish reason and TTFT;
   - `failed`, when the model call fails partway. The client keeps the words so far and can offer a retry, and the
     error is rethrown for the app to log.

   The client closes its EventSource on either one. EventSource reconnects after any end of stream, and would ask
   again. A dropped connection instead of `failed` looks like a network error to the client.
5. **Framing**: content can't break the event format. Data is split on CR, LF and CRLF, because a bare CR is a line break to the browser: unsplit, `hello\rid: 999` sets the event id the browser sends back on reconnect. An id or event name containing a line break is refused. A framework that writes the response itself uses `formatEvent()`.
6. **Live feeds**: give each event a monotonically increasing `id`. `serveFeed()` subscribes **first**, then replays what came after `Last-Event-ID`, then follows live, deduping by id so nothing published during the replay is lost. If the client is older than the buffer, send `reset` and let the client re-fetch full state, instead of leaving a silent gap.
   Ids must keep increasing **across restarts**. A buffer that numbers from 1 gives the new process's events the old numbers, so a client reconnecting after a deploy with `Last-Event-ID: 3` silently skips the new 1–3. `createReplayBuffer()` starts its ids from the clock (milliseconds × 1000), so an id from before the restart gets a `reset`. Use lossy `trySend()` for high-rate dashboard updates and send the latest snapshot when the client catches up.
   A subscriber that stops reading must not queue events forever: `serveFeed(sse, feed, { maxQueue })` drops a client more than `maxQueue` events behind (default 1,000, the replay buffer's size) and calls `onOverflow`. Its browser reconnects with `Last-Event-ID` and gets either a replay or a `reset`. Without the cap, one stalled tab buffered 40 MB in the test.
   A feed never ends on its own, so a deploy has to end it. Open feeds with `openSse(req, res, { closeOn: ctx.shuttingDown })` (`service-hardening`): the stream ends cleanly once the load balancer has stopped sending traffic to this instance, and the browser reconnects to one that stays. Without it, every open feed makes the deploy wait out the whole grace period and end forced: 5 s in the journey test, 95 ms with it. Don't end streams earlier, at the start of the shutdown. The reconnect would come back to this instance, still draining, only to be ended again a few seconds later.
7. **Limits**: browsers allow 6 HTTP/1.1 connections per origin. Serve over HTTP/2, or multiplex channels on one stream per tab. Cap concurrent streams per user and tenant, and include streams in the server's in-flight accounting (`service-hardening`). A long-lived stream counts as one in-flight request for its whole life, so size `maxInFlight` with that in mind, or exempt streams and cap them separately.
8. **Metrics**: TTFT p50/p95, tokens/s, active streams, disconnects before `done`, `failed` endings, refused lossy sends.

## Verification (required)

[verify/tests/skills/sse-streaming.test.ts](../../verify/tests/skills/sse-streaming.test.ts), real HTTP:
- Correct headers; tokens (including multi-line data) arrive in order, followed by `done`.
- A client disconnecting after 2 tokens stops the upstream generator (its `finally` runs).
- Reconnect with the id of the first event → receives exactly the next two, including one published *while* connected.
- A `Last-Event-ID` from before a restart → `reset`, not the new process's events ([regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts)).
- A client older than the replay buffer gets `reset`, not a gap.
- Heartbeat comments arrive.
- A stalled client (never reads) makes `trySend` refuse, and the buffered bytes stay bounded.
- A stalled feed subscriber is disconnected once it is `maxQueue` events behind, instead of buffering every event ([regressions/round-2.test.ts](../../verify/tests/regressions/round-2.test.ts)).
- `closeOn` ends a stream cleanly when it fires, and a stream that ended first leaves no listener on the signal.
- [The assistant journey](../../verify/tests/journeys/assistant-stream.test.ts) reads every stream as the browser
  reads it ([support/sse-parser.ts](../../verify/tests/support/sse-parser.ts)) and covers:
  - a whole answer in Vietnamese, with emoji and paragraph breaks;
  - a tab closed after the first words: the model call is cancelled, with no error logged;
  - a model failing halfway: the stream ends with `failed`;
  - a feed that reconnects after losing the network: the missed events arrive once, in order;
  - a deploy: the stream ends once traffic has moved, and the feed resumes on the new instance;
  - a `Last-Event-ID` nobody issued: `reset`.
- [Properties](../../verify/tests/properties/formats.test.ts): any text, any id and any event name round-trip to the
  browser exactly (a CR or CRLF arrives as LF), and an id or event with a line break is refused.

Manually: throttle the network in browser devtools and toggle offline; the UI should resume without duplicate or missing tokens. Behind the real proxy or CDN, confirm tokens arrive incrementally rather than all at once at the end (a buffering proxy).

## Record the decision
ADR: SSE vs WebSocket, replay store, lossless vs lossy per stream type, connection limits.

## Common mistakes
- Compression middleware or proxy buffering on the stream route: the "stream" arrives in one piece after 20 s.
- Not passing the abort signal to the LLM SDK: closed tabs keep generating paid tokens.
- `res.write` in a loop without checking its return value: memory grows per slow client.
- Event ids that aren't monotonic per channel (random UUIDs), so replay can't work.
- Replaying *before* subscribing: events published in between are lost.
- A per-client queue with no limit between the feed and a slow socket: memory grows with every event the stalled client hasn't read.
- Splitting data on `\n` only. The browser also breaks lines on a bare `\r`, so user content can write its own `id:` or `event:` field.
- Testing streams with a parser that splits on `\n\n`. It can't see what the browser sees; read them as the spec says (`verify/tests/support/sse-parser.ts`).
- Calling feed subscribers bare inside `append()`. One that throws keeps the event from every subscriber after it and fails the publisher. Each one runs through `callHook`; so does `onOverflow`, which used to keep the stalled client connected when it threw.
