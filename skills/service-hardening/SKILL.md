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
| Drain delay | 5 s | Time for the LB/endpoints to stop routing after readiness fails. |
| Per-dependency timeouts | Ask per dependency | DB 2–5 s, internal HTTP 1–3 s, LLM 30–120 s (streaming). |
| Language | Node reference + Go notes | Same checklist; see [references/go.md](references/go.md). |

## Implementation steps

Start from [references/server.ts](references/server.ts) (node:http; wrap Express/Fastify/Hono inside `handler`):

1. **Inbound timeouts**: `headersTimeout` (slowloris), `requestTimeout`, and `keepAliveTimeout` above the LB's idle timeout.
2. **Outbound deadlines**: every DB query, `fetch` and LLM call gets `deadline(ms, ctx.signal)`. An unbounded call is a resource leak waiting for a slow day.
3. **Cancellation**: `ctx.signal` aborts when the client disconnects. Thread it into queries and LLM calls so abandoned requests stop costing money (this matters most for LLM streaming).
4. **Load shedding**: an in-flight counter. Beyond `maxInFlight`, reply `503` immediately. Fast rejection keeps latency bounded for the requests you do accept; that *is* backpressure at the HTTP layer. Pair it with the `rate-limiting` skill for per-tenant fairness.
5. **Probes**: `/livez` checks the process only, with **no dependency checks** (otherwise a DB blip restarts every pod at once). `/readyz` runs dependency checks with a timeout and returns 503 while draining.
6. **Body limits**: `readBody(req, maxBytes)` checks `content-length` first, then counts while streaming. Return 413, not an out-of-memory crash.
7. **Request ids**: accept a well-formed `x-request-id` or generate one; echo it, log it, put it on spans.
8. **Graceful shutdown** via `installSignalHandlers(shutdown)`: readiness → 503 → wait `drainDelayMs` → stop accepting + close idle keep-alive sockets → wait for in-flight up to `shutdownGraceMs` → force-close → `onShutdown` hooks (DB pools, telemetry flush). A second signal force-exits. In Docker, run node as PID 1 with `exec`/`--init`, or `tini`, so SIGTERM actually reaches it.
9. **Config validation at startup**: fail fast on missing env vars, before readiness ever turns green.

The full go-live list is in [references/checklist.md](references/checklist.md).

## Verification (required)

[verify/tests/service-hardening.test.ts](../../verify/tests/service-hardening.test.ts):
- Shutdown during 3 in-flight slow requests → all 3 return 200; `/readyz` returns 503 and new work returns 503 during the drain; the listener is closed afterwards; `forced: false`.
- A straggler beyond the grace period → shutdown still completes within the bound (`forced: true`) and the hooks still run.
- `maxInFlight: 2` with 5 concurrent → exactly two 200s and three 503s, and the 503s are immediate (< 150 ms).
- Client abort → the handler's signal fires, with the request id preserved.
- Handler throws → 500, the server keeps serving; oversize body → 413; malformed incoming request ids are replaced.
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
