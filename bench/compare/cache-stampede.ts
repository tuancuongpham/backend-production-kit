// A hot key expires under load: 4 app instances get 50 requests each for it at the same moment, and the
// origin query takes 100 ms. How many origin calls, and how long do the 200 requests wait?
//   A. cache-aside: GET, on a miss load and SET          (what most code does)
//   B. A + single-flight inside each process
//   C. shipped createCache: single-flight + a Redis lock across instances
//   C, stale: the same, when the entry is stale rather than gone (stale-while-revalidate)
// Run inside the Docker network:  npm run bench:docker -- bench/compare/cache-stampede.ts
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../../verify/tests/helpers.ts';
import { createCache } from '../../skills/cache-stampede/references/cache.ts';
import { save, stats, table } from './lib.ts';

const INSTANCES = 4;
const PER_INSTANCE = 50;
const clients = Array.from({ length: INSTANCES }, () => new Redis(REDIS_URL));
let originCalls = 0;
const load = async () => {
  originCalls++;
  await sleep(100);
  return { rows: 42 };
};

type Get = (key: string) => Promise<unknown>;
const naive = (redis: Redis, prefix: string): Get => async (key) => {
  const hit = await redis.get(`${prefix}:${key}`);
  if (hit) return JSON.parse(hit);
  const v = await load();
  await redis.set(`${prefix}:${key}`, JSON.stringify(v), 'EX', 60);
  return v;
};
const singleFlight = (get: Get): Get => {
  const inflight = new Map<string, Promise<unknown>>();
  return (key) => {
    const shared = inflight.get(key);
    if (shared) return shared;
    const p = get(key).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
};

async function storm(makeGet: (redis: Redis, prefix: string) => Get, prepare?: (prefix: string) => Promise<void>) {
  const prefix = `stampede:${Date.now()}:${Math.random()}`;
  await prepare?.(prefix);
  const gets = clients.map((r) => makeGet(r, prefix));
  originCalls = 0;
  const latencies = await Promise.all(
    gets.flatMap((get) =>
      Array.from({ length: PER_INSTANCE }, async () => {
        const t0 = performance.now();
        await get('dashboard');
        return performance.now() - t0;
      }),
    ),
  );
  const s = stats(latencies);
  await sleep(300); // background refreshes count too: let them finish
  return { 'origin calls': originCalls, 'p50 ms': s.p50, 'p95 ms': s.p95, 'max ms': Math.round(Math.max(...latencies)) };
}

const shipped = (redis: Redis, prefix: string): Get => {
  const cache = createCache({ redis, prefix, ttlSec: 60, staleSec: 60 });
  return (key) => cache.get(key, load);
};
const rows = [
  { variant: 'A. cache-aside', ...(await storm(naive)) },
  { variant: 'B. cache-aside + single-flight per process', ...(await storm((r, p) => singleFlight(naive(r, p)))) },
  { variant: 'C. shipped: single-flight + Redis lock', ...(await storm(shipped)) },
  {
    variant: 'C. shipped, entry stale (stale-while-revalidate)',
    ...(await storm(shipped, async (p) => {
      // A value written an hour ago: its fresh time is over, its stale window isn't.
      await clients[0].set(`${p}:dashboard`, `${Date.now() - 1}:${JSON.stringify({ rows: 41 })}`, 'PX', 60_000); // a stale entry
    })),
  },
];
table(rows);
save('cache-stampede', { instances: INSTANCES, requestsPerInstance: PER_INSTANCE, originMs: 100, rows });
for (const c of clients) c.disconnect();
