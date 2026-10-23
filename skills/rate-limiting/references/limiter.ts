// Distributed token-bucket rate limiter on Redis, with an explicit, tested policy for
// when Redis is slow or down. Redis client should be created with:
//   new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 50, lazyConnect: true })
// so commands fail fast instead of queueing while disconnected, and `await redis.connect()` before the
// instance reports ready: without the queue, commands sent before the connection is up fail too.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { CircuitBreaker } from './circuit-breaker.ts';
import { callHook } from './hooks.ts';
import { withTimeout } from './with-timeout.ts';

const LUA = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf8');
// EVALSHA sends 40 bytes instead of the whole script on every request; Redis also skips re-hashing it.
const LUA_SHA = createHash('sha1').update(LUA).digest('hex');
/** The longest timer Node can schedule: it runs a longer one after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * What to do when Redis can't answer in time:
 *  - 'open'   allow everything (availability first; fine for cheap read endpoints)
 *  - 'closed' reject everything (protect expensive/abusable endpoints: login, OTP, LLM calls)
 *  - 'local'  enforce a per-instance bucket of capacity/instances (degraded but still bounded)
 */
export type FailureMode = 'open' | 'closed' | 'local';

export interface LimiterOptions {
  redis: Redis;
  capacity: number;
  refillPerSec: number;
  failureMode: FailureMode;
  /** Approximate number of app instances; sizes the local fallback bucket. */
  instances?: number;
  /** Hard cap on how long we wait for Redis per check. */
  timeoutMs?: number; // default 50
  /**
   * Consecutive Redis failures before we stop trying for `breakerCooldownMs`; after it, one check probes Redis
   * while the others keep using the failure mode.
   */
  breakerThreshold?: number; // default 5
  breakerCooldownMs?: number; // default 5000
  keyPrefix?: string; // default 'rl'
  onRedisError?: (err: unknown) => unknown;
  now?: () => number; // injectable for tests
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  source: 'redis' | 'local' | 'fail-open' | 'fail-closed';
}

/** Per-instance token buckets for the 'local' failure mode, LRU-bounded. */
class LocalBuckets {
  readonly #buckets = new Map<string, { tokens: number; ts: number }>();
  readonly #capacity: number;
  readonly #rate: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  constructor(capacity: number, rate: number, now: () => number, maxKeys = 50_000) {
    this.#capacity = capacity;
    this.#rate = rate;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }
  take(key: string, cost: number): Omit<LimitResult, 'source'> {
    const now = this.#now();
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, ts: now };
    // Re-insert so Map order is least-recently-used first. With plain set() an existing key keeps its
    // original position, so the busiest (oldest) subject was evicted first and came back with a full bucket.
    this.#buckets.delete(key);
    // No time is negative: a wall clock stepped back an hour (NTP correcting a drifted host) emptied the bucket for that
    // hour. The Redis script clamps the same way.
    b.tokens = Math.min(this.#capacity, b.tokens + (Math.max(0, now - b.ts) * this.#rate) / 1000);
    b.ts = now;
    let allowed = false;
    let retryAfterMs = 0;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      allowed = true;
    } else {
      retryAfterMs = Math.ceil(((cost - b.tokens) * 1000) / this.#rate);
    }
    this.#buckets.set(key, b);
    if (this.#buckets.size > this.#maxKeys) this.#buckets.delete(this.#buckets.keys().next().value!); // evict LRU
    return { allowed, remaining: Math.floor(b.tokens), retryAfterMs };
  }
}

export class RateLimiter {
  readonly #redis: Redis;
  readonly #capacity: number;
  readonly #refillPerSec: number;
  readonly #failureMode: FailureMode;
  readonly #timeoutMs: number;
  readonly #prefix: string;
  readonly #onRedisError?: (err: unknown) => unknown;
  readonly #breaker: CircuitBreaker;
  readonly #local: LocalBuckets;
  #redisCalls = 0;

  constructor(o: LimiterOptions) {
    // A bucket that never refills makes the script divide by zero and PEXPIRE "inf": every Redis call
    // errors (allowed ones too) and the limiter silently runs in its failure mode. Refuse it up front.
    if (!(o.capacity > 0) || !Number.isFinite(o.capacity)) throw new Error('rate limiter: capacity must be a positive number');
    if (!(o.refillPerSec > 0) || !Number.isFinite(o.refillPerSec)) {
      throw new Error('rate limiter: refillPerSec must be a positive number (for a fixed quota, use a tiny rate and a long-lived key)');
    }
    if (!['open', 'closed', 'local'].includes(o.failureMode)) throw new Error(`rate limiter: unknown failureMode "${o.failureMode}"`);
    // From an unset environment variable these are NaN. A NaN timeout fails every Redis call at once, so every check
    // runs in the failure mode: with 'open', no limit at all. A NaN instance count makes the local bucket NaN.
    const instances = o.instances ?? 1;
    if (!Number.isInteger(instances) || instances < 1) throw new RangeError(`rate limiter: instances must be a positive integer, got ${instances}`);
    const timeoutMs = o.timeoutMs ?? 50;
    // Past what Node can schedule (about 24.8 days) the timeout runs after 1 ms, the same as NaN: every check fails over.
    if (!(timeoutMs > 0) || timeoutMs > MAX_TIMER_MS) throw new RangeError(`rate limiter: timeoutMs must be a number of ms from 1 to ${MAX_TIMER_MS}, got ${timeoutMs}`);
    const now = o.now ?? Date.now;
    this.#redis = o.redis;
    this.#capacity = o.capacity;
    this.#refillPerSec = o.refillPerSec;
    this.#failureMode = o.failureMode;
    this.#timeoutMs = timeoutMs;
    this.#prefix = o.keyPrefix ?? 'rl';
    this.#onRedisError = o.onRedisError;
    this.#breaker = new CircuitBreaker({ threshold: o.breakerThreshold ?? 5, cooldownMs: o.breakerCooldownMs ?? 5000, now });
    this.#local = new LocalBuckets(Math.max(1, Math.floor(o.capacity / instances)), o.refillPerSec / instances, now);
  }

  /** `subject` is e.g. `tenant:42:route:/v1/chat`. Use a hash tag `{...}` around it on Redis Cluster. */
  async check(subject: string, cost = 1): Promise<LimitResult> {
    // A negative cost would add tokens; one above capacity could never pass and only ever earns a 429.
    if (!(cost > 0) || !Number.isFinite(cost) || cost > this.#capacity) throw new RangeError(`rate limiter: cost must be in (0, capacity], got ${cost}`);
    const key = `${this.#prefix}:{${subject}}`;
    if (!this.#breaker.tryAcquire()) return this.#fallback(key, cost); // open: don't wait on a dead Redis
    try {
      const [allowed, remaining, retryAfterMs] = await this.#callRedis(key, cost);
      this.#breaker.success();
      return { allowed: allowed === 1, remaining, retryAfterMs, source: 'redis' };
    } catch (err) {
      callHook(this.#onRedisError, err); // a metrics hook that fails can't change the decision
      this.#breaker.failure();
      return this.#fallback(key, cost);
    }
  }

  stats() {
    return { redisCalls: this.#redisCalls, breakerOpen: this.#breaker.state === 'open' };
  }

  #fallback(key: string, cost: number): LimitResult {
    switch (this.#failureMode) {
      case 'open':
        return { allowed: true, remaining: 0, retryAfterMs: 0, source: 'fail-open' };
      case 'closed':
        return { allowed: false, remaining: 0, retryAfterMs: 1000, source: 'fail-closed' };
      case 'local':
        return { ...this.#local.take(key, cost), source: 'local' };
    }
  }

  #callRedis(key: string, cost: number): Promise<[number, number, number]> {
    this.#redisCalls++;
    const args = [key, this.#capacity, this.#refillPerSec, cost] as const;
    const call = (this.#redis.evalsha(LUA_SHA, 1, ...args) as Promise<[number, number, number]>).catch((err: Error) => {
      // First call on this Redis (or after SCRIPT FLUSH / failover): load it once, then it's cached.
      if (!String(err?.message).startsWith('NOSCRIPT')) throw err;
      return this.#redis.eval(LUA, 1, ...args) as Promise<[number, number, number]>;
    });
    return withTimeout(call, this.#timeoutMs, () => new Error(`rate limiter: redis timeout after ${this.#timeoutMs}ms`));
  }
}

export const createRateLimiter = (o: LimiterOptions) => new RateLimiter(o);

/** Standard response headers. Always send Retry-After with 429 so well-behaved clients back off. */
export function rateLimitHeaders(r: LimitResult, capacity: number): Record<string, string> {
  const h: Record<string, string> = {
    'RateLimit-Limit': String(capacity),
    'RateLimit-Remaining': String(Math.max(0, r.remaining)),
  };
  if (!r.allowed) h['Retry-After'] = String(Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
  return h;
}
