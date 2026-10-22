---
name: cache-stampede
description: Add a read-through cache (Redis) that holds when a hot key expires under load — single-flight per process plus a Redis lock across instances so one request recomputes while the rest wait or get the stale value (stale-while-revalidate), jittered TTLs, cached misses, tenant-scoped keys, invalidation after commit, and failing open when Redis is down. Use whenever the user caches database queries, API responses, dashboards, LLM results or computed aggregates, sees load spikes or database CPU jumps when a cache entry expires, or mentions cache-aside, Redis cache, thundering herd, dogpile, cache stampede, "cache hết hạn là DB quá tải", "cache theo tenant".
---

# Cache that survives a stampede

The usual cache-aside code (`get`, and on a miss `load` then `set`) is right with one user and wrong with many.
When a popular entry expires, every request that arrives before the first `set` misses too. All of them run the
same expensive query at once. The database falls over at exactly the moment the cache was supposed to protect it,
and the cache can't refill because the query never finishes.

The fix is to make sure that only one caller recomputes a key at a time, and that nobody else has to wait for it
when a slightly old value is acceptable.

```
get(key, load)
  in-process single-flight  → callers in this instance share one promise
  fresh in Redis            → return it
  stale (within staleSec)   → return it now; one instance refreshes in the background (Redis lock)
  missing                   → the lock holder loads and writes; other instances poll for its value
                              (and load themselves after waitMs if the holder died)
  Redis slow or down        → load directly: the cache fails open
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| What may be stale, and for how long | Fresh `ttlSec`, then served stale for another `staleSec` while refreshing | Prices, balances and permissions often may not be stale. Dashboards and catalogs usually may. Decide per key family. |
| Invalidation | TTL, plus `invalidate(key)` after the commit (an outbox consumer for cross-service) | Never invalidate before the commit: a concurrent read refills the cache with the old row. |
| Keys | `tenantKey(tenantId, …)` from authentication, with a version in the prefix | A key without the tenant serves one customer's data to another. Bump the prefix version to drop all entries after a format change. |
| Redis down | Fail open: go to the origin, still single-flight per process | Fail closed only when the origin can't take the full load; then shed load (`service-hardening`). |
| Misses | Cache `null` like any value | Otherwise lookups of ids that don't exist all reach the database. |
| Where | Redis for shared state; an in-process LRU in front only for tiny, hot, rarely changing data | Two layers means two invalidation problems. |

## Implementation steps

1. **Client.** Create the ioredis client with `enableOfflineQueue: false` and a short `commandTimeout`, and add
   `redis.on('error', log)`. Each cache call also races `timeoutMs` (50 ms), and a slow Redis counts as down.
   Without the offline queue, commands fail until the connection is up, so connect before the instance reports
   ready (`lazyConnect: true`, then `await redis.connect()`).
2. **Cache.** `createCache({ redis, prefix: 'cache:v1', ttlSec, staleSec })` from
   [references/cache.ts](references/cache.ts), then `cache.get(tenantKey(tenant, 'dashboard', id), () => query())`.
   - `tenantKey` percent-encodes each part, so a `:` inside an id can't shift the boundaries. `('org:1',
     'dashboard')` and `('org', '1:dashboard')` would otherwise share a key: one tenant's answer served to
     another. A part from user text (a search query cut at a fixed length) may hold half an emoji, which becomes
     U+FFFD instead of throwing.
   - The lock (`SET NX PX`, released by a compare-and-delete script) must outlive the slowest load (`lockMs`).
   - A stale value is served while one instance refreshes it. If the refresh fails, the stale value keeps being
     served until `staleSec` runs out; then the error surfaces.
   - TTLs get up to 10% jitter, so keys written together don't expire together.
   - **A hit returns exactly what a miss returned.** Every value goes through the codec (JSON by default) on the way
     out too, so a `Date` is an ISO string on a miss as well as on a hit. Code that passed its tests on misses would
     otherwise break on hits in production. For richer types, pass `codec` (superjson, msgpack). A value the codec
     can't encode (a `BigInt` in JSON) is served uncached and reported, not failed.
   - Redis calls go through a circuit breaker: after 3 failures in a row the cache stops asking for a second, then
     one probe decides. A black-holed Redis then costs nothing per request instead of `timeoutMs` each.
   - Copy `circuit-breaker.ts`, `hooks.ts` and `with-timeout.ts` along with `cache.ts`: they are the kit's shared building blocks.
3. **Writes.** Run `invalidate(key)` after the transaction commits. For data changed by other services, publish
   the change through the outbox (`outbox-pattern`) and invalidate in its consumer.
   - A fill or a refresh may have read the old row just before the commit and still be loading. `invalidate` leaves
     a tombstone for `lockMs`, and every write is conditional: it lands only if the key still holds what the writer
     saw before it loaded (one Lua script, one key, so Redis Cluster is fine). With a plain `DEL`, the slow fill
     wrote the old row back after the invalidation, and it was served for a whole TTL.
   - `createCache` refuses a NaN or negative `timeoutMs`, `staleSec`, `jitter`, `lockMs` or `waitMs`: each one
     read from an unset environment variable switched the cache off without an error.
4. **Metrics.** Track hits (fresh and stale), misses, origin loads per key family, lock waits that fell back to
   loading, and `onError` (Redis trouble). A falling hit rate after a deploy usually means a key format changed.

## Verification (required)

Against real Redis. [verify/tests/skills/cache-stampede.test.ts](../../verify/tests/skills/cache-stampede.test.ts) covers:
- 100 concurrent misses in one process → **one origin call**.
- **Three instances × 30 concurrent misses → one origin call** across all of them.
- Once stale, 20 callers get the old value in under 100 ms while a single 200 ms refresh runs; afterwards they get
  the new value. The origin was called twice in total, not 21 times.
- Origin down: the stale value is served until it expires for good, the failed refresh is reported, then the error
  surfaces.
- An instance that died holding the lock blocks the others for `waitMs` only.
- Redis down → requests reach the origin, still one call per key per process, and the outage is reported.
- Jittered TTLs are spread over more than a second; `null` results are cached; keys carry the tenant.
- [regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts): a hit deep-equals the miss that filled
  it (a `Date` field included); a `BigInt` value is served uncached; 20 requests against a black-holed Redis take
  181 ms in total, against 1,236 ms without the breaker.
- [regressions/round-6.test.ts](../../verify/tests/regressions/round-6.test.ts): a fill, and a background refresh,
  that read the old row before the commit and finish after `invalidate()` don't overwrite it; the next read loads the
  new row.

How to write these tests so they prove something:
- Fire the requests concurrently against an origin that takes long enough to overlap them, and count origin calls.
  Sequential gets never stampede.
- Use several cache instances with separate Redis connections. That is what several app servers look like.

## Record the decision
ADR: staleness allowed per key family, invalidation path, key format and versioning, behaviour when Redis is down.

## Common mistakes
- **Plain cache-aside on a hot key.** With 4 instances × 50 requests arriving as the key expired, the origin ran 200
  times. Single-flight per process brought that to 4, and the Redis lock to 1. When the entry was only stale,
  requests were answered in 0.7 ms from the old value while one refresh ran ([performance](../../docs/performance.md)).
  The origin here was a 100 ms sleep. A real database running the same heavy query 200 times at once also slows
  everything else down.
- Every key expiring at the same time (a cache warmed in one batch with one TTL): a scheduled stampede. Add jitter.
- A lock without an expiry, or released without checking the token: a crashed holder blocks the key forever, or one
  instance deletes another's lock.
- Waiting on a lock forever: when the holder dies, every request for that key hangs.
- Invalidating before the commit, or only in the instance that made the change.
- Invalidating with `DEL` while a fill is loading. It read the row before the change, writes after the `DEL`, and
  the old value is cached for a full TTL. Writes must check that the key is still what they saw.
- Cache keys without the tenant (or user) when the value depends on who asks.
- Letting a Redis outage take the site down with it: no timeout, an offline queue, no fallback to the origin.
- Returning the loaded value on a miss and the decoded one on a hit. Dates, Maps and class instances change type
  between the first request and the second.
- **A background refresh nobody awaits.** If anything in it can reject (an `onError` hook that throws, for one), the
  rejection is unhandled and Node ends the process, from a request that had already been answered. The refresh
  reports through `callHook` and can't reject.
