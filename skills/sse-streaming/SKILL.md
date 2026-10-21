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

Reference: [references/sse.ts](references/sse.ts).

1. **Headers**: `text/event-stream`, `cache-control: no-cache, no-transform` (no-transform stops proxy gzip buffering), `x-accel-buffering: no` (nginx), plus a `retry:` hint. Disable response compression on this route.
2. **Heartbeat**: send a comment line every ~15 s. Idle proxies (often 30–60 s) otherwise cut the stream silently.
3. **Cancellation**: `openSse()` exposes `signal`, which aborts on client disconnect. Pass it **into the LLM SDK call**, so the provider stops generating. Leaving the loop is not enough, because the provider may still bill the rest.
4. **Tokens**: `streamTokens(sse, iterable)` uses lossless `send()`, which awaits `drain` when the socket buffer is full. Backpressure propagates to the token iterator, so you never build an unbounded queue. It ends with a `done` event (usage, finish reason) and measures TTFT.
5. **Live feeds**: give each event a monotonically increasing `id`. `serveFeed()` subscribes **first**, then replays what came after `Last-Event-ID`, then follows live, deduping by id so nothing published during the replay is lost. If the client is older than the buffer, send `reset` and let the client re-fetch full state, instead of leaving a silent gap. Use lossy `trySend()` for high-rate dashboard updates and send the latest snapshot when the client catches up.
6. **Limits**: browsers allow 6 HTTP/1.1 connections per origin. Serve over HTTP/2, or multiplex channels on one stream per tab. Cap concurrent streams per user and tenant, and include streams in the server's in-flight accounting (`service-hardening`). A long-lived stream counts as one in-flight request for its whole life, so size `maxInFlight` with that in mind, or exempt streams and cap them separately.
7. **Metrics**: TTFT p50/p95, tokens/s, active streams, disconnects before `done`, refused lossy sends.

## Verification (required)

[verify/tests/sse-streaming.test.ts](../../verify/tests/sse-streaming.test.ts), real HTTP:
- Correct headers; tokens (including multi-line data) arrive in order, followed by `done`.
- A client disconnecting after 2 tokens stops the upstream generator (its `finally` runs).
- Reconnect with `Last-Event-ID: 1` → receives exactly ids 2 and 3, including one published *while* connected.
- A client older than the replay buffer gets `reset`, not a gap.
- Heartbeat comments arrive.
- A stalled client (never reads) makes `trySend` refuse, and the buffered bytes stay bounded.

Manually: throttle the network in browser devtools and toggle offline; the UI should resume without duplicate or missing tokens. Behind the real proxy or CDN, confirm tokens arrive incrementally rather than all at once at the end (a buffering proxy).

## Record the decision
ADR: SSE vs WebSocket, replay store, lossless vs lossy per stream type, connection limits.

## Common mistakes
- Compression middleware or proxy buffering on the stream route: the "stream" arrives in one piece after 20 s.
- Not passing the abort signal to the LLM SDK: closed tabs keep generating paid tokens.
- `res.write` in a loop without checking its return value: memory grows per slow client.
- Event ids that aren't monotonic per channel (random UUIDs), so replay can't work.
- Replaying *before* subscribing: events published in between are lost.
