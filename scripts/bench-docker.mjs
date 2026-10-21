#!/usr/bin/env node
// Run a benchmark inside the Docker network, next to Postgres and Redis (Linux, no host port forwarding).
//   npm run bench:docker -- bench/compare/semantic-cache.ts
// Why: on Docker Desktop (Windows/macOS), host → container traffic goes through a proxy that adds ~44 ms
// to every message of 16 KB or more (bench/compare/transport.ts). Anything that sends embeddings is
// distorted by it; production apps talk to the database directly.
import { spawnSync } from 'node:child_process';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/bench-docker.mjs <script.ts> [args…]');
  process.exit(2);
}
const result = spawnSync(
  'docker',
  [
    'run', '--rm', '--network', 'verify_default',
    '-v', `${process.cwd()}:/app`, '-w', '/app',
    '-e', 'KIT_PG_URL=postgres://kit:kit@postgres:5432/kit',
    '-e', 'KIT_REDIS_URL=redis://redis:6379',
    'node:24-alpine', 'node', script, ...args,
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
