// Distributed token-bucket rate limiter on Redis, with an explicit, tested policy for
// when Redis is slow or down. Redis client should be created with:
//   new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 50 })
// so commands fail fast instead of queueing while disconnected.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';

const LUA = readFileSync(new URL('./token-bucket.lua', import.meta.url), 'utf8');
// EVALSHA sends 40 bytes instead of the whole script on every request; Redis also skips re-hashing it.
const LUA_SHA = createHash('sha1').update(LUA).digest('hex');

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
  /** Consecutive Redis failures before we stop trying for `breakerCooldownMs`. */
  breakerThreshold?: number; // default 5
  breakerCooldownMs?: number; // default 5000
  keyPrefix?: string; // default 'rl'
  onRedisError?: (err: unknown) => void;
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  source: 'redis' | 'local' | 'fail-open' | 'fail-closed';
}

class LocalBuckets {
  #buckets = new Map<string, { tokens: number; ts: number }>();
  #capacity: number;
  #rate: number;
  #maxKeys: number;
  constructor(capacity: number, rate: number, maxKeys = 50_000) {
    this.#capacity = capacity;
    this.#rate = rate;
    this.#maxKeys = maxKeys;
  }
  take(key: string, cost: number): Omit<LimitResult, 'source'> {
    const now = Date.now();
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, ts: now };
    // Re-insert so Map order is least-recently-used first. With plain set() an existing key keeps its
    // original position, so the busiest (oldest) subject was evicted first and came back with a full bucket.
    this.#buckets.delete(key);
    b.tokens = Math.min(this.#capacity, b.tokens + ((now - b.ts) * this.#rate) / 1000);
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

export function createRateLimiter(o: LimiterOptions) {
  // A bucket that never refills makes the script divide by zero and PEXPIRE "inf": every Redis call
  // errors (allowed ones too) and the limiter silently runs in its failure mode. Refuse it up front.
  if (!(o.capacity > 0) || !Number.isFinite(o.capacity)) throw new Error('rate limiter: capacity must be a positive number');
  if (!(o.refillPerSec > 0) || !Number.isFinite(o.refillPerSec)) {
    throw new Error('rate limiter: refillPerSec must be a positive number (for a fixed quota, use a tiny rate and a long-lived key)');
  }
  const timeoutMs = o.timeoutMs ?? 50;
  const threshold = o.breakerThreshold ?? 5;
  const cooldown = o.breakerCooldownMs ?? 5000;
  const prefix = o.keyPrefix ?? 'rl';
  const instances = Math.max(1, o.instances ?? 1);
  const local = new LocalBuckets(Math.max(1, Math.floor(o.capacity / instances)), o.refillPerSec / instances);

  let failures = 0;
  let openUntil = 0;
  let redisCalls = 0;

  function fallback(key: string, cost: number): LimitResult {
    switch (o.failureMode) {
      case 'open':
        return { allowed: true, remaining: 0, retryAfterMs: 0, source: 'fail-open' };
      case 'closed':
        return { allowed: false, remaining: 0, retryAfterMs: 1000, source: 'fail-closed' };
      case 'local':
        return { ...local.take(key, cost), source: 'local' };
    }
  }

  async function callRedis(key: string, cost: number): Promise<[number, number, number]> {
    redisCalls++;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`rate limiter: redis timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const call = (o.redis.evalsha(LUA_SHA, 1, key, o.capacity, o.refillPerSec, cost) as Promise<[number, number, number]>).catch(
        (err: Error) => {
          // First call on this Redis (or after SCRIPT FLUSH / failover): load it once, then it's cached.
          if (!String(err?.message).startsWith('NOSCRIPT')) throw err;
          return o.redis.eval(LUA, 1, key, o.capacity, o.refillPerSec, cost) as Promise<[number, number, number]>;
        },
      );
      // If the timeout wins, the Redis call may still reject later: swallow it, or Node
      // treats it as an unhandled rejection and kills the process.
      call.catch(() => {});
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `subject` is e.g. `tenant:42:route:/v1/chat`. Use a hash tag `{...}` around it on Redis Cluster. */
  async function check(subject: string, cost = 1): Promise<LimitResult> {
    const key = `${prefix}:{${subject}}`;
    if (Date.now() < openUntil) return fallback(key, cost); // breaker open: don't wait on a dead Redis
    try {
      const [allowed, remaining, retryAfterMs] = await callRedis(key, cost);
      failures = 0;
      return { allowed: allowed === 1, remaining, retryAfterMs, source: 'redis' };
    } catch (err) {
      o.onRedisError?.(err);
      if (++failures >= threshold) openUntil = Date.now() + cooldown;
      return fallback(key, cost);
    }
  }

  return { check, stats: () => ({ redisCalls, breakerOpen: Date.now() < openUntil }) };
}

/** Standard response headers. Always send Retry-After with 429 so well-behaved clients back off. */
export function rateLimitHeaders(r: LimitResult, capacity: number): Record<string, string> {
  const h: Record<string, string> = {
    'RateLimit-Limit': String(capacity),
    'RateLimit-Remaining': String(Math.max(0, r.remaining)),
  };
  if (!r.allowed) h['Retry-After'] = String(Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
  return h;
}
