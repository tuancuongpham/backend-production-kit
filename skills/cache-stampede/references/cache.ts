// Read-through cache on Redis that holds when a hot key expires under load:
//  - one origin call per key at a time: single-flight inside the process, a short Redis lock across instances;
//  - stale-while-revalidate: once a value goes stale it is still served while one caller refreshes it;
//  - jittered TTLs, so keys written together don't expire together;
//  - fails open: if Redis is slow or down, requests go to the origin (still one call per key per process), and
//    after a few failures a circuit breaker stops paying the Redis timeout on every request;
//  - a hit returns exactly what a miss returned: every value goes through the codec, cached or not.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import { CircuitBreaker } from './circuit-breaker.ts';
import { callHook } from './hooks.ts';
import { withTimeout } from './with-timeout.ts';

/**
 * How values are stored. The default is JSON: a Date comes back as an ISO string, a Map as {}, and a BigInt can't
 * be stored at all (it is then served uncached). Plug in superjson, msgpack or your own for richer types.
 */
export interface Codec {
  encode(value: unknown): string;
  decode(raw: string): unknown;
}

export const jsonCodec: Codec = { encode: (v) => JSON.stringify(v), decode: (s) => JSON.parse(s) };

export interface CacheOptions {
  redis: Redis;
  /** Key namespace, e.g. 'cache:v1'. Bump the version to drop every entry after a format change. */
  prefix: string;
  /** Fresh for this many seconds. */
  ttlSec: number;
  /** After going stale, served for this many more seconds while one caller refreshes it. Default ttlSec. */
  staleSec?: number;
  /** Each write's fresh time is stretched by up to this fraction. Default 0.1. */
  jitter?: number;
  /** How long a refresh may hold the lock. Keep it above the slowest load. Default 10 s. */
  lockMs?: number;
  /** On a miss without the lock: how long to wait for the holder's value before loading anyway. Default 2 s. */
  waitMs?: number;
  /** A Redis call slower than this counts as Redis being down. Default 50 ms. */
  timeoutMs?: number;
  /** Redis failures in a row before the cache stops asking for `cooldownMs`; then one probe. Default 3 → 1 s. */
  breaker?: { threshold: number; cooldownMs: number };
  codec?: Codec;
  /** Redis failures and values the codec can't handle. The request is served either way. */
  onError?: (err: unknown) => unknown;
  random?: () => number;
}

/** The longest timer Node can schedule: it runs a longer one after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Redis couldn't be asked: down, too slow, or the breaker is open. */
const UNAVAILABLE = Symbol('redis unavailable');
/** Thrown instead of calling Redis while the breaker is open. Expected, so not reported. */
const CIRCUIT_OPEN = new Error('cache: redis circuit open');
const UNLOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
/** What invalidate() leaves in place of an entry: a miss, and a marker no older write matches. */
const TOMBSTONE = '~';
/**
 * Writes only if the key still holds what the writer saw before it loaded: ARGV[1] is '' for nothing, else a prefix of
 * the value it read. A fill or refresh that read the old row before a change then can't land after the change's
 * invalidate(), which replaced the entry with a tombstone. One key, so it works on Redis Cluster too.
 */
const STORE_IF_UNCHANGED = `local cur = redis.call('get', KEYS[1])
if ARGV[1] == '' then
  if cur then return 0 end
elseif not cur or string.sub(cur, 1, #ARGV[1]) ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1`;

/**
 * Keys always carry the tenant: one tenant's cached answer must never reach another. Each part is percent-encoded,
 * so a ':' inside an id can't shift the boundaries: tenant "org:1" with part "dashboard" and tenant "org" with part
 * "1:dashboard" would otherwise share a key. Ids made of letters, digits and -_.!~*'() (UUIDs, numbers) are left as
 * they are. A part from user text may hold half of an emoji (a query cut at a fixed length), on which
 * encodeURIComponent throws: it becomes U+FFFD first, as it would on its way to Redis anyway.
 */
export const tenantKey = (tenantId: string, ...parts: Array<string | number>) =>
  ['t', tenantId, ...parts].map((p) => encodeURIComponent(String(p).toWellFormed())).join(':');

// An entry is "<freshUntil, epoch ms>:<codec output>": the codec's output stays opaque to the cache.
type Entry = { value: unknown; freshUntil: number };
/** A read: the entry (null on a miss) and what a later write must still find there (see STORE_IF_UNCHANGED). */
type Observed = { entry: Entry | null; seen: string };

export class ReadThroughCache {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;
  readonly #staleMs: number;
  readonly #jitter: number;
  readonly #lockMs: number;
  readonly #waitMs: number;
  readonly #timeoutMs: number;
  readonly #codec: Codec;
  readonly #breaker: CircuitBreaker;
  readonly #onError?: (err: unknown) => unknown;
  readonly #random: () => number;
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #refreshing = new Set<string>();

  constructor(o: CacheOptions) {
    // From an unset environment variable each of these is NaN, which switches the cache off one way or another: a
    // write with PX NaN fails, a NaN lock is never taken, a NaN timeout fails every call. Refused at startup.
    const setting = (name: string, v: number, min: number, above = false) => {
      if (!Number.isFinite(v) || v < min || (above && v === min)) throw new RangeError(`cache: ${name} must be a number ${above ? 'above' : 'of at least'} ${min}, got ${v}`);
      return v;
    };
    this.#redis = o.redis;
    this.#prefix = o.prefix;
    this.#ttlMs = setting('ttlSec', o.ttlSec, 0, true) * 1000;
    this.#staleMs = setting('staleSec', o.staleSec ?? o.ttlSec, 0) * 1000;
    this.#jitter = setting('jitter', o.jitter ?? 0.1, 0);
    this.#lockMs = Math.ceil(setting('lockMs', o.lockMs ?? 10_000, 0, true));
    this.#waitMs = setting('waitMs', o.waitMs ?? 2_000, 0);
    this.#timeoutMs = setting('timeoutMs', o.timeoutMs ?? 50, 0, true);
    // Past what Node can schedule (about 24.8 days), the timeout runs after 1 ms: every Redis call would fail.
    if (this.#timeoutMs > MAX_TIMER_MS) throw new RangeError(`cache: timeoutMs must be at most ${MAX_TIMER_MS}, got ${this.#timeoutMs}`);
    this.#codec = o.codec ?? jsonCodec;
    this.#breaker = new CircuitBreaker(o.breaker ?? { threshold: 3, cooldownMs: 1000 });
    this.#onError = o.onError;
    this.#random = o.random ?? Math.random;
  }

  /**
   * The cached value for `key`, loading it with `load` when needed. A `load` that returns null is cached too,
   * so lookups of ids that don't exist don't all reach the database. A `load` that throws is not cached.
   */
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const k = `${this.#prefix}:${key}`;
    const shared = this.#inflight.get(k);
    if (shared) return shared as Promise<T>;
    const p = this.#resolve(k, load).finally(() => this.#inflight.delete(k));
    this.#inflight.set(k, p);
    return p;
  }

  /**
   * Drop a key after the data behind it changed. Call it after the commit, e.g. from an outbox consumer. The entry
   * becomes a tombstone for lockMs: a fill or a refresh that read the old row before the change and finishes after
   * this call finds it and doesn't write. (With a plain DEL it wrote the old row back, for a whole TTL.)
   */
  async invalidate(key: string): Promise<void> {
    await this.#call(() => this.#redis.set(`${this.#prefix}:${key}`, `${TOMBSTONE}${randomUUID()}`, 'PX', this.#lockMs));
  }

  async #resolve<T>(k: string, load: () => Promise<T>): Promise<T> {
    const read = await this.#read(k);
    if (read === UNAVAILABLE) return this.#roundTrip(await load()).value;
    const { entry, seen } = read;
    if (entry && Date.now() < entry.freshUntil) return entry.value as T;
    if (entry) {
      this.#refreshInBackground(k, load, seen);
      return entry.value as T; // stale but within staleSec: answer now
    }
    return this.#fill(k, load, seen);
  }

  async #fill<T>(k: string, load: () => Promise<T>, seen: string): Promise<T> {
    const token = await this.#lock(k);
    if (token === UNAVAILABLE) return this.#roundTrip(await load()).value; // can't coordinate: fail open
    if (token) {
      try {
        return await this.#store(k, await load(), seen);
      } finally {
        await this.#unlock(k, token);
      }
    }
    // Another instance is loading this key: wait for its value instead of piling onto the origin.
    for (const deadline = Date.now() + this.#waitMs; Date.now() < deadline; ) {
      await sleep(25);
      const read = await this.#read(k);
      if (read === UNAVAILABLE) break;
      if (read.entry) return read.entry.value as T;
      seen = read.seen;
    }
    return this.#store(k, await load(), seen); // the holder died or is too slow: don't wait forever
  }

  #refreshInBackground<T>(k: string, load: () => Promise<T>, seen: string) {
    if (this.#refreshing.has(k)) return;
    this.#refreshing.add(k);
    // Nobody awaits this: it must never reject, or the unhandled rejection ends the process.
    void (async () => {
      const token = await this.#lock(k);
      if (typeof token !== 'string') return; // someone else refreshes, or Redis is down
      try {
        await this.#store(k, await load(), seen);
      } catch (err) {
        this.#report(err); // keep serving the stale value until it expires for good
      } finally {
        await this.#unlock(k, token);
      }
    })().finally(() => this.#refreshing.delete(k));
  }

  /** The value as a hit will return it, and its encoding (null if the codec can't handle it). */
  #roundTrip<T>(value: T): { value: T; encoded: string | null } {
    try {
      const encoded = this.#codec.encode(value);
      return { value: this.#codec.decode(encoded) as T, encoded };
    } catch (err) {
      this.#report(err);
      return { value, encoded: null }; // served, not cached
    }
  }

  /** Cache a freshly loaded value, unless the key changed since `seen`; returns the value as a hit will. */
  async #store<T>(k: string, loaded: T, seen: string): Promise<T> {
    const { value, encoded } = this.#roundTrip(loaded);
    if (encoded === null) return value;
    const fresh = Math.round(this.#ttlMs * (1 + this.#jitter * this.#random()));
    const entry = `${Date.now() + fresh}:${encoded}`;
    await this.#call(() => this.#redis.eval(STORE_IF_UNCHANGED, 1, k, seen, entry, Math.ceil(fresh + this.#staleMs))).catch((err) => this.#report(err));
    return value;
  }

  async #read(k: string): Promise<Observed | typeof UNAVAILABLE> {
    let raw: string | null;
    try {
      raw = await this.#call(() => this.#redis.get(k));
    } catch (err) {
      this.#report(err);
      return UNAVAILABLE;
    }
    if (raw === null) return { entry: null, seen: '' };
    if (raw.startsWith(TOMBSTONE)) return { entry: null, seen: raw }; // invalidated: a miss
    const sep = raw.indexOf(':');
    const freshUntil = Number(raw.slice(0, sep));
    try {
      if (sep < 1 || !Number.isFinite(freshUntil)) throw new Error('not an entry of this cache');
      return { entry: { value: this.#codec.decode(raw.slice(sep + 1)), freshUntil }, seen: raw.slice(0, sep + 1) };
    } catch (err) {
      // Another format (an old version, another app) or a codec change: a miss, and the next fill overwrites it.
      this.#report(new Error(`cache: unreadable entry ${k}: ${(err as Error).message}`));
      return { entry: null, seen: raw.slice(0, 64) };
    }
  }

  /** A lock token, null if another instance holds the lock, UNAVAILABLE if Redis can't be asked. */
  async #lock(k: string): Promise<string | null | typeof UNAVAILABLE> {
    const token = randomUUID();
    try {
      return (await this.#call(() => this.#redis.set(`${k}:lock`, token, 'PX', this.#lockMs, 'NX'))) === 'OK' ? token : null;
    } catch (err) {
      this.#report(err);
      return UNAVAILABLE;
    }
  }

  async #unlock(k: string, token: string) {
    await this.#call(() => this.#redis.eval(UNLOCK, 1, `${k}:lock`, token)).catch(() => {}); // it expires on its own anyway
  }

  /** Every Redis call: through the breaker, and no longer than timeoutMs. */
  async #call<T>(op: () => Promise<T>): Promise<T> {
    if (!this.#breaker.tryAcquire()) throw CIRCUIT_OPEN;
    try {
      const result = await withTimeout(op(), this.#timeoutMs, () => new Error(`cache: redis timeout after ${this.#timeoutMs} ms`));
      this.#breaker.success();
      return result;
    } catch (err) {
      this.#breaker.failure();
      throw err;
    }
  }

  #report(err: unknown) {
    if (err !== CIRCUIT_OPEN) callHook(this.#onError, err);
  }
}

export const createCache = (o: CacheOptions) => new ReadThroughCache(o);
