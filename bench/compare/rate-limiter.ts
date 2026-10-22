// Rate limiter throughput: where does the time go, and what helps?
//   client: ioredis defaults vs enableAutoPipelining (batches concurrent commands into one write)
//   load:   sequential vs 64 concurrent callers
//   split:  the limiter (timeout race, breaker, fallback) vs a bare EVALSHA of the same script vs PING,
//           plus Redis's own execution time per script call from INFO commandstats
// Run inside the Docker network:  npm run bench:docker -- bench/compare/rate-limiter.ts
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../../verify/tests/support/infra.ts';
import { createRateLimiter } from '../../skills/rate-limiting/references/limiter.ts';
import { save, table, throughput } from './lib.ts';

const LUA = readFileSync(new URL('../../skills/rate-limiting/references/token-bucket.lua', import.meta.url), 'utf8');

async function usecPerCall(redis: Redis, command: string): Promise<number> {
  const info = await redis.info('commandstats');
  const m = new RegExp(`cmdstat_${command}:.*usec_per_call=([0-9.]+)`).exec(info);
  return m ? Number(m[1]) : NaN;
}

const rows: Array<Record<string, unknown>> = [];
for (const auto of [false, true]) {
  const redis = new Redis(REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2000,
    lazyConnect: true,
    enableAutoPipelining: auto,
  });
  await redis.connect();
  const prefix = `cmp-${auto}-${Date.now()}`;
  const rl = createRateLimiter({ redis, capacity: 1e9, refillPerSec: 1e9, failureMode: 'closed', keyPrefix: prefix, timeoutMs: 2000 });
  let degraded = 0;
  const check = async (i: number) => {
    if ((await rl.check(`tenant:${i % 100}`)).source !== 'redis') degraded++;
  };
  await throughput(2000, 64, check); // warm-up (also loads the script)
  const sequential = await throughput(3000, 1, check);
  await redis.config('RESETSTAT');
  const concurrent = await throughput(30_000, 64, check);
  const serverUs = await usecPerCall(redis, 'evalsha');
  const sha = (await redis.script('LOAD', LUA)) as string;
  const bare = await throughput(30_000, 64, (i) => redis.evalsha(sha, 1, `${prefix}:bare:{tenant:${i % 100}}`, 1e9, 1e9, 1));
  const ping = await throughput(30_000, 64, () => redis.ping());
  rows.push({
    client: auto ? 'enableAutoPipelining: true' : 'ioredis defaults',
    'limiter checks/s, sequential': sequential,
    'limiter checks/s, 64 concurrent': concurrent,
    'bare EVALSHA/s, 64 concurrent': bare,
    'PING/s, 64 concurrent': ping,
    'Redis µs per script call': serverUs,
    'fell back to failure mode': degraded,
  });
  redis.disconnect();
}
table(rows);
save('rate-limiter', { rows });
