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
   - `timeoutMs` races each check, and the losing promise is caught so a late rejection can't crash Node;
   - the circuit breaker stops calling Redis after N consecutive failures for a cooldown, so a dead Redis costs 0 ms instead of 50 ms per request;
   - `local` mode keeps a per-instance bucket of `capacity / instances`. That is approximate, but still bounded;
   - keys look like `rl:{subject}`. The hash tag keeps Redis Cluster happy.
3. **Middleware.** Call `check(subject, cost)` early. On deny, return `429` with `rateLimitHeaders()`; always include `Retry-After`. Add `RateLimit-*` headers on success too, so clients can pace themselves.
4. **Observability.** Count allowed/denied per subject class and per `source` (`redis`, `local`, `fail-open`, `fail-closed`). An alert on non-`redis` sources tells you the limiter is degraded before customers do.

## Verification (required)

[verify/tests/rate-limiting.test.ts](../../verify/tests/rate-limiting.test.ts), against real Redis:
- A burst of capacity + 1 → the last one is denied with `retryAfterMs` > 0 and a `Retry-After` header.
- Tokens refill after waiting. Subjects are isolated. Cost > 1 works.
- **Atomicity**: 90 concurrent checks from 3 separate clients (≈ 3 app instances) against capacity 20 → exactly 20 allowed.
- **Slow Redis** (server blocked by a busy script): the check falls back within `timeoutMs`, and *no unhandled rejection* surfaces afterwards. This test catches the classic `Promise.race` crash; it fails without the `.catch`.
- **Redis down**: `closed` → denied in < 300 ms; `open` → allowed; `local` → enforces `capacity / instances`.
- Breaker: after the threshold, Redis isn't called any more.

Before launch, load-test the real endpoint (k6/autocannon) to confirm limiter latency at p99 and that 429s don't cascade into client retry storms.

## Record the decision
ADR: failure mode per endpoint class (with the reason), subject choice, limits per plan, multi-region stance.

## Common mistakes
- Default ioredis options: an offline queue plus 20 retries means requests hang for seconds during a Redis outage.
- `GET` then `SET` from the app: races let bursts through. It must be one atomic script.
- Using app-server `Date.now()` inside distributed state: clock skew equals free tokens.
- Trusting `X-Forwarded-For` from anyone: attackers rotate it and get unlimited buckets.
- No `Retry-After`: clients retry immediately and amplify the overload.
- Evicting the local fallback map in insertion order. JavaScript's `Map.set` on an existing key keeps its old position, so the *busiest* subject is the oldest entry and the first to be evicted, coming back with a full bucket during an outage. Delete and re-insert on every access (true LRU).
- Sending the whole Lua script on every request. Use `EVALSHA` with an `EVAL` fallback on `NOSCRIPT` (after a restart or failover). This saves bandwidth on real networks; on localhost the difference is not measurable.
