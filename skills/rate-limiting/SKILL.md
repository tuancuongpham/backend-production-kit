---
name: rate-limiting
description: Add distributed rate limiting (Redis token bucket via an atomic Lua script) with an explicit, tested behaviour for when Redis is slow, down or partitioned — fail-open, fail-closed, or degraded local limits plus a circuit breaker. Use whenever the user wants to throttle an API, protect login/OTP/LLM endpoints, add per-tenant or per-plan quotas, return 429s, or asks about "giới hạn request", "chống spam", "rate limit theo tenant", "Redis chết thì sao".
---

# Distributed rate limiting that degrades on purpose

The algorithm is the easy part. The real design work is **what happens when the limiter's own dependency fails**. A limiter that hangs when Redis hangs turns a Redis blip into a full outage. One that silently fails open leaves the LLM bill unprotected. This skill makes that behaviour a deliberate, tested choice.

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| **Failure mode per endpoint class** | `local` for normal API, `closed` for login/OTP/LLM, `open` for cheap reads | This is an availability-vs-protection trade-off the user owns. Write it in the ADR. |
| Subject (what is limited) | `tenant` (+ route class) for B2B; `user` or IP for consumer apps | Behind a proxy, take the IP from the *trusted* proxy header only. |
| Limits | Ask per plan | Capacity = allowed burst; refill = sustained rate. |
| Algorithm | Token bucket | Sliding-window log if a hard "max N per exact window" is contractual. GCRA is equivalent for most purposes. |
| Multi-region | One Redis per region, limits split per region | A truly global limiter needs cross-region consensus on every request: slow and fragile. Say so. |
| Where to enforce | App layer for business quotas; WAF/CDN for DDoS | The app limiter is not DDoS protection. |

LLM *token or cost* budgets are a separate concern; see the `llm-gateway` skill. This skill limits request rate.

## Implementation steps

1. **Lua script.** [references/token-bucket.lua](references/token-bucket.lua) does read, refill, take and expire atomically. It uses `redis.call('TIME')` so app servers' clock skew doesn't matter, and idle keys expire on their own.
2. **Client.** [references/limiter.ts](references/limiter.ts):
   - configure ioredis with `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `commandTimeout: 50`. Otherwise commands **queue while disconnected** and requests hang;
   - with the offline queue off, a command sent before the connection is ready fails at once. Connect (`lazyConnect: true`, then `await redis.connect()`) before the instance reports ready, or the first requests after every deploy run in the failure mode;
   - `timeoutMs` races each check, and the losing promise is caught so a late rejection can't crash Node;
   - the circuit breaker stops calling Redis after N consecutive failures for a cooldown, so a dead Redis costs 0 ms instead of 50 ms per request. When the cooldown ends, **one** check probes Redis while the others keep using the failure mode at once; without that half-open state, every request in flight at that moment paid the full timeout again. The breaker is the kit's shared `circuit-breaker.ts`: copy it, and `with-timeout.ts`, along with `limiter.ts`;
   - `check(subject, cost)` refuses a `cost` that isn't in (0, capacity]: a negative cost would add tokens, and one above capacity could never pass;
   - `local` mode keeps a per-instance bucket of `capacity / instances`. That is approximate, but still bounded;
   - keys look like `rl:{subject}`. The hash tag keeps Redis Cluster happy;
   - `createRateLimiter` refuses `capacity` or `refillPerSec` that isn't a positive number. A bucket that never refills makes the script divide by zero, so every call errors and the limiter silently runs in its failure mode;
   - **capacity**:
     - Redis runs the script in about 9 µs, so one primary can do at most ~100k checks/s across all app instances;
     - one Node instance tops out near 57k checks/s, far above what it serves in HTTP requests;
     - leave ioredis's `enableAutoPipelining` off: it made PING 2.7× faster but EVALSHA 22% slower;
     - beyond one primary, shard subjects over Redis Cluster (the hash tags are already in place).
3. **Middleware.** Call `check(subject, cost)` early. On deny, return `429` with `rateLimitHeaders()`; always include `Retry-After`. Add `RateLimit-*` headers on success too, so clients can pace themselves.
4. **Observability.** Count allowed/denied per subject class and per `source` (`redis`, `local`, `fail-open`, `fail-closed`). An alert on non-`redis` sources tells you the limiter is degraded before customers do.

## Verification (required)

[verify/tests/rate-limiting.test.ts](../../verify/tests/rate-limiting.test.ts), against real Redis:
- A burst of capacity + 1 → the last one is denied with `retryAfterMs` > 0 and a `Retry-After` header.
- Tokens refill after waiting. Subjects are isolated. Cost > 1 works.
- **Atomicity**: 90 concurrent checks from 3 separate clients (≈ 3 app instances) against capacity 20 → exactly 20 allowed.
- **Slow Redis** (server blocked by a busy script): the check falls back within `timeoutMs`, and *no unhandled rejection* surfaces afterwards. This test catches the classic `Promise.race` crash; it fails without the `.catch`.
- **Redis down**: `closed` → denied in < 300 ms; `open` → allowed; `local` → enforces `capacity / instances`.
- Breaker: after the threshold, Redis isn't called any more. After the cooldown, 20 concurrent checks send 1 probe to a dead Redis, not 20, and all 20 answer within the probe's timeout ([latent-bugs-round3.test.ts](../../verify/tests/latent-bugs-round3.test.ts)).
- Through Toxiproxy, Redis 300 ms slow against `timeoutMs: 50` → the check falls back to `local` in under 150 ms, and is back on `redis` once the latency is gone ([resilience-testing.test.ts](../../verify/tests/resilience-testing.test.ts)).
- Config: `refillPerSec: 0`, `capacity: 0` and `NaN` are rejected at startup. With refill 0 the Lua script itself errors on every call ([latent-bugs-round2.test.ts](../../verify/tests/latent-bugs-round2.test.ts)).

Before launch, load-test the real endpoint (k6/autocannon) to confirm limiter latency at p99 and that 429s don't cascade into client retry storms.

## Record the decision
ADR: failure mode per endpoint class (with the reason), subject choice, limits per plan, multi-region stance.

## Common mistakes
- Default ioredis options: an offline queue plus 20 retries means requests hang for seconds during a Redis outage.
- Turning the offline queue off without connecting first: until the connection is up, every check fails into the failure mode.
- `GET` then `SET` from the app: races let bursts through. It must be one atomic script.
- Using app-server `Date.now()` inside distributed state: clock skew equals free tokens.
- Trusting `X-Forwarded-For` from anyone: attackers rotate it and get unlimited buckets.
- No `Retry-After`: clients retry immediately and amplify the overload.
- Evicting the local fallback map in insertion order. JavaScript's `Map.set` on an existing key keeps its old position, so the *busiest* subject is the oldest entry and the first to be evicted, coming back with a full bucket during an outage. Delete and re-insert on every access (true LRU).
- Sending the whole Lua script on every request. Use `EVALSHA` with an `EVAL` fallback on `NOSCRIPT` (after a restart or failover). This saves bandwidth on real networks; on localhost the difference is not measurable.
- A "fixed quota" modelled as a bucket with `refillPerSec: 0`. The script divides by zero, every check errors, and the endpoint runs fail-open or fail-closed while dashboards show Redis as healthy. Use a tiny refill rate on a long-lived key.
