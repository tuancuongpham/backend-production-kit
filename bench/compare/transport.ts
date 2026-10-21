// Round-trip latency vs parameter size, with nothing else going on (SELECT length($1)).
// Run it twice to see whether your setup has a transport cliff:
//   node bench/compare/transport.ts                       (from the host)
//   npm run bench:docker -- bench/compare/transport.ts    (inside the Docker network)
// Measured on Windows 11 + Docker Desktop: from the host, every message >= 16 KB costs ~44 ms
// (a 1536-dim embedding sent as text is 15–31 KB); inside the network the same queries take 0.2–0.5 ms.
import pg from 'pg';
import { ADMIN_URL } from '../../verify/tests/helpers.ts';
import { save } from './lib.ts';

const client = new pg.Client({ connectionString: ADMIN_URL });
await client.connect();
const points: Array<{ kb: number; ms: number }> = [];
for (let kb = 1; kb <= 64; kb += 1) {
  const payload = 'x'.repeat(kb * 1024);
  for (let i = 0; i < 3; i++) await client.query('SELECT length($1::text) AS n', [payload]);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) await client.query('SELECT length($1::text) AS n', [payload]);
  const ms = Math.round(((performance.now() - t0) / 10) * 100) / 100;
  points.push({ kb, ms });
  console.log(`${String(kb).padStart(3)} KB: ${ms.toFixed(2).padStart(6)} ms ${'#'.repeat(Math.min(60, Math.round(ms)))}`);
}
const where = process.env.KIT_PG_URL?.includes('@postgres:') ? 'docker-network' : 'host';
save(`transport-${where}`, { where, points });
await client.end();
