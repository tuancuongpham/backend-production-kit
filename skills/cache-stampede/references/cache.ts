// Read-through cache on Redis that holds when a hot key expires under load:
//  - one origin call per key at a time: single-flight inside the process, a short Redis lock across instances;
//  - stale-while-revalidate: once a value goes stale it is still served while one caller refreshes it;
//  - jittered TTLs, so keys written together don't expire together;
//  - fails open: if Redis is slow or down, requests go to the origin (still one call per key per process).
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';

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
  onError?: (err: unknown) => void;
  random?: () => number;
}

interface Envelope<T> {
  v: T;
  /** epoch ms */
  freshUntil: number;
}

const DOWN = Symbol('redis down');
const UNLOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/** Keys always carry the tenant: one tenant's cached answer must never reach another. */
export const tenantKey = (tenantId: string, ...parts: Array<string | number>) => `t:${tenantId}:${parts.join(':')}`;

export function createCache(o: CacheOptions) {
  const ttlMs = o.ttlSec * 1000;
  const staleMs = (o.staleSec ?? o.ttlSec) * 1000;
  const jitter = o.jitter ?? 0.1;
  const lockMs = o.lockMs ?? 10_000;
  const waitMs = o.waitMs ?? 2_000;
  const timeoutMs = o.timeoutMs ?? 50;
  const random = o.random ?? Math.random;
  const inflight = new Map<string, Promise<unknown>>();
  const refreshing = new Set<string>();

  /** Races a Redis call against timeoutMs. The losing call's late rejection is swallowed, not left unhandled. */
  async function redis<T>(call: Promise<T>): Promise<T> {
    call.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`cache: redis timeout after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function read<T>(k: string): Promise<Envelope<T> | null | typeof DOWN> {
    try {
      const raw = await redis(o.redis.get(k));
      return raw === null ? null : (JSON.parse(raw) as Envelope<T>);
    } catch (err) {
      o.onError?.(err);
      return DOWN;
    }
  }

  async function write<T>(k: string, v: T) {
    const fresh = Math.round(ttlMs * (1 + jitter * random()));
    const envelope: Envelope<T> = { v, freshUntil: Date.now() + fresh };
    await redis(o.redis.set(k, JSON.stringify(envelope), 'PX', fresh + staleMs)).catch((err) => o.onError?.(err));
  }

  /** A lock token, null if another instance holds the lock, DOWN if Redis can't be asked. */
  async function lock(k: string): Promise<string | null | typeof DOWN> {
    const token = randomUUID();
    try {
      return (await redis(o.redis.set(`${k}:lock`, token, 'PX', lockMs, 'NX'))) === 'OK' ? token : null;
    } catch (err) {
      o.onError?.(err);
      return DOWN;
    }
  }

  async function unlock(k: string, token: string) {
    await redis(o.redis.eval(UNLOCK, 1, `${k}:lock`, token)).catch(() => {}); // it expires on its own anyway
  }

  async function fill<T>(k: string, load: () => Promise<T>): Promise<T> {
    const token = await lock(k);
    if (token === DOWN) return load(); // can't coordinate: fail open
    if (token) {
      try {
        const v = await load();
        await write(k, v);
        return v;
      } finally {
        await unlock(k, token);
      }
    }
    // Another instance is loading this key: wait for its value instead of piling onto the origin.
    for (const deadline = Date.now() + waitMs; Date.now() < deadline; ) {
      await sleep(25);
      const cached = await read<T>(k);
      if (cached === DOWN) break;
      if (cached) return cached.v;
    }
    return load(); // the holder died or is too slow: don't wait forever
  }

  function refreshInBackground<T>(k: string, load: () => Promise<T>) {
    if (refreshing.has(k)) return;
    refreshing.add(k);
    (async () => {
      const token = await lock(k);
      if (typeof token !== 'string') return; // someone else refreshes, or Redis is down
      try {
        await write(k, await load());
      } catch (err) {
        o.onError?.(err); // keep serving the stale value until it expires for good
      } finally {
        await unlock(k, token);
      }
    })().finally(() => refreshing.delete(k));
  }

  async function resolve<T>(k: string, load: () => Promise<T>): Promise<T> {
    const cached = await read<T>(k);
    if (cached === DOWN) return load();
    if (cached && Date.now() < cached.freshUntil) return cached.v;
    if (cached) {
      refreshInBackground(k, load);
      return cached.v; // stale but within staleSec: answer now
    }
    return fill(k, load);
  }

  /**
   * The cached value for `key`, loading it with `load` when needed. A `load` that returns null is cached too,
   * so lookups of ids that don't exist don't all reach the database. A `load` that throws is not cached.
   */
  function get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const k = `${o.prefix}:${key}`;
    const shared = inflight.get(k);
    if (shared) return shared as Promise<T>;
    const p = resolve(k, load).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }

  /** Drop a key after the data behind it changed. Call it after the commit, e.g. from an outbox consumer. */
  async function invalidate(key: string) {
    await redis(o.redis.del(`${o.prefix}:${key}`));
  }

  return { get, invalidate };
}
