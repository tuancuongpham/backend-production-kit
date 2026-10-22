---
name: service-hardening
description: Make an HTTP service production-ready — timeouts everywhere, load shedding/backpressure, liveness vs readiness probes, client-disconnect cancellation, body limits, request ids, and graceful shutdown that drains in-flight requests on SIGTERM. Use whenever the user creates or deploys an API server (Node, Go, Rust, Python), containerizes it for Docker/Kubernetes/ECS/Cloud Run, asks about "10k concurrent connections", 502s during deploys, hanging requests, "graceful shutdown", "health check", "server bị treo khi tải cao", or before any go-live review.
---

# Service hardening

High concurrency is rarely the hard part: Node and Go handle 10k sockets on a laptop. Outages come from what happens **at the edges**: a deploy kills in-flight requests, a slow dependency holds every connection open, an overloaded server answers everyone slowly instead of some quickly. This skill turns those edges into explicit, tested behaviour.

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Runtime / platform | Ask | K8s: `terminationGracePeriodSeconds` (default 30 s) bounds shutdown. Serverless platforms manage some of this; skip what they own. |
| Max in-flight per instance | From a load test; start at 256 | Above it → immediate 503 + `Retry-After`. A guess is fine for a first deploy if it's recorded as one. |
| LB idle timeout | Ask (ALB 60 s, GCLB 600 s, nginx 75 s) | `keepAliveTimeout` must be **greater**, or you get random 502s. |
| Drain delay | 5 s | Time for the LB/endpoints to stop routing after readiness fails. Requests that still arrive are served. |
| Per-dependency timeouts | Ask per dependency | DB 2–5 s, internal HTTP 1–3 s, LLM 30–120 s (streaming). |
| Language | Node reference + Go notes | Same checklist; see [references/go.md](references/go.md). |

## Implementation steps

Start from [references/server.ts](references/server.ts) (node:http; wrap Express/Fastify/Hono inside `handler`), with `with-timeout.ts`, the kit's shared deadline helper:

1. **Inbound timeouts**: `headersTimeout` (slowloris), `requestTimeout`, and `keepAliveTimeout` above the LB's idle timeout.
2. **Outbound deadlines**: every DB query, `fetch` and LLM call gets `deadline(ms, ctx.signal)`. An unbounded call is a resource leak waiting for a slow day.
3. **Cancellation**: `ctx.signal` aborts when the client disconnects. Thread it into queries and LLM calls so abandoned requests stop costing money (this matters most for LLM streaming).
4. **Load shedding**: an in-flight counter. Beyond `maxInFlight`, reply `503` immediately. Fast rejection keeps latency bounded for the requests you do accept; that *is* backpressure at the HTTP layer. Pair it with the `rate-limiting` skill for per-tenant fairness.
5. **Probes**: `/livez` checks the process only, with **no dependency checks** (otherwise a DB blip restarts every pod at once). `/readyz` runs dependency checks with a timeout and returns 503 while draining.
6. **Body limits**: `readBody(req, maxBytes)` checks `content-length` first, then counts while streaming. Return 413, not an out-of-memory crash. Make sure the client actually *receives* the 413. Out of the box, Node either keeps reading and discarding the rest of the upload so it can reuse the connection, or closes a socket that still has unread upload data. In that case the kernel answers with a reset that wipes out the 413, and the client sees `ECONNRESET` and retries the whole upload. The reference stops reading, sends the 413 with `Connection: close`, ends the socket gracefully and destroys it after `rejectLingerMs` (2 s): the client gets its 413, and the server reads under 8 MB of a 32 MB upload.
7. **Request ids**: accept a well-formed `x-request-id` or generate one; echo it, log it, put it on spans.
8. **Graceful shutdown** via `installSignalHandlers(shutdown)`. The steps, in order:
   1. readiness returns 503, and the server waits `drainDelayMs`. Requests the load balancer still sends meanwhile
      are served, each with `Connection: close`, so the client's next request opens a connection that goes to
      another instance. Answering them 503 would be the very deploy error the delay exists to avoid;
   2. it stops accepting, closes idle keep-alive sockets and ends long-lived responses;
   3. it waits for in-flight requests, up to `shutdownGraceMs`, then force-closes the rest;
   4. it runs the `onShutdown` hooks (DB pools, telemetry flush).

   A second signal force-exits. In Docker, run node as PID 1 with `exec`/`--init`, or `tini`, so SIGTERM actually
   reaches it.
   Requests that never end on their own (event streams, long polls) end on `ctx.shuttingDown`. That signal fires
   at step 2, once the load balancer sends traffic elsewhere, so their clients reconnect to an instance that stays.
   For SSE that is `openSse(req, res, { closeOn: ctx.shuttingDown })`. Without it, each open stream makes the deploy
   wait out the whole grace period and end forced.
9. **Config validation at startup**: fail fast on missing env vars, before readiness ever turns green.
   `createHardenedServer` refuses a NaN or negative setting with a `RangeError`: `Number(process.env.X)` of an
   unset variable is NaN, and NaN compares false with everything. `maxInFlight: NaN` shed nothing, and a NaN grace
   period cut every in-flight request the moment a deploy started.
   `listen()` rejects when the port is taken (`EADDRINUSE`) instead of crashing on an unhandled `'error'` event.

The full go-live list is in [references/checklist.md](references/checklist.md).

## Verification (required)

[verify/tests/skills/service-hardening.test.ts](../../verify/tests/skills/service-hardening.test.ts):
- Shutdown during 3 in-flight slow requests → all 3 return 200; `/readyz` returns 503 while new work is still answered during the drain, with `Connection: close`; the listener is closed afterwards; `forced: false`.
- A straggler beyond the grace period → shutdown still completes within the bound (`forced: true`) and the hooks still run.
- `ctx.shuttingDown` fires after the drain delay, not during it: an open stream ends then, and the shutdown finishes
  without waiting out the grace period (`forced: false`).
- A clean shutdown leaves no timer behind, so the process exits at once
  ([regressions/round-4.test.ts](../../verify/tests/regressions/round-4.test.ts)). It used to stay alive for the whole
  `shutdownGraceMs`.
- A client that disconnects mid-upload fails `readBody` at once; `deadline(ms, ctx.signal)` aborts on whichever
  comes first.
- `installSignalHandlers`: SIGTERM drains then exits 0, a second signal exits 1 at once, a failing shutdown exits 1.
- The [journeys](../../verify/tests/journeys) run the hardened server as real applications do:
  - a shopper's payment cut off by a deploy is retried on the new instance and never creates a second order;
  - a live feed open during a deploy ends once traffic has moved.
- `maxInFlight: 2` with 5 concurrent → exactly two 200s and three 503s, and the 503s are immediate (< 150 ms).
- Client abort → the handler's signal fires, with the request id preserved.
- Handler throws → 500, the server keeps serving; oversize body → 413; malformed incoming request ids are replaced.
- A 32 MB upload, chunked or with a declared `Content-Length`, gets a 413 response (not a reset), and the server reads less than 8 MB of it ([regressions/round-2.test.ts](../../verify/tests/regressions/round-2.test.ts)).
- Readiness follows dependency checks while liveness doesn't.

Then **load-test** the real service (k6/autocannon) at 2× expected peak. Record p50/p95/p99, error rate and the in-flight cap where shedding starts; the `adr-writer` benchmark template has the format. Finally, do a rolling deploy under load and confirm zero 5xx caused by the deploy.

## Record the decision
ADR: in-flight cap (with its load-test evidence), timeout values, and shutdown timings relative to the platform's grace period.

## Common mistakes
- `keepAliveTimeout` below the LB idle timeout. Node's default is 5 s, which produces intermittent 502s that nobody can reproduce.
- Readiness that never fails during shutdown: the LB keeps sending traffic to a closing pod.
- `npm start` as PID 1: npm doesn't forward SIGTERM, so the pod gets SIGKILLed after 30 s.
- Dependency checks in liveness: one DB hiccup becomes a cluster-wide restart.
- Retrying 503s without jitter or backoff on the client side, which amplifies overload.
- Rejecting an oversized upload by destroying the request: the client gets a connection reset instead of a 413, can't tell "too big" from "network blip", and retries the same upload.
- A `Promise.race` against a bare `setTimeout` for the grace period. The timer outlives the race, and keeps the process alive for the whole grace period after a clean drain. Use `withTimeout`, which clears its timer.
- Answering 503 during the drain delay. The load balancer keeps sending requests until it notices readiness, and
  each of them fails: the 5xx-on-every-deploy the delay was meant to prevent. Serve them, and close their
  connections.
- `Number(process.env.SHUTDOWN_GRACE_MS)` with the variable unset: NaN, which turned the grace period into
  "cut everything now". Read settings with a default and check them; the server refuses NaN.
