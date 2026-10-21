// Shared helpers for the approach comparisons in bench/compare/. Each script prints a markdown table
// and writes bench/results/compare-<name>.json. Needs `npm run verify:up` (Postgres + Redis).
import { mkdirSync, writeFileSync } from 'node:fs';

export interface Stats {
  p50: number;
  p95: number;
  mean: number;
}

export function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { p50: round(at(0.5)), p95: round(at(0.95)), mean: round(s.reduce((a, b) => a + b, 0) / s.length) };
}

/** Per-call latency in ms, after a warm-up. */
export async function latency(n: number, fn: (i: number) => Promise<unknown>, warmup = Math.min(50, n)): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

/** Like latency(), for calls that do setup/teardown around the part being measured and return its ms. */
export async function selfTimed(n: number, fn: (i: number) => Promise<number>, warmup = Math.min(50, n)): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) samples.push(await fn(i));
  return stats(samples);
}

/** Operations per second with `concurrency` callers pulling from one counter. */
export async function throughput(total: number, concurrency: number, fn: (i: number) => Promise<unknown>): Promise<number> {
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) await fn(next++);
    }),
  );
  return Math.round((total / (performance.now() - t0)) * 1000);
}

/** Deterministic random vector in [-0.5, 0.5) (mulberry32), independent across seeds. */
export function randomVector(seed: number, dims = 1536): number[] {
  let a = seed >>> 0;
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  }
  return out;
}

export const near = (center: number[], seed: number, sigma: number) => {
  const n = randomVector(seed, center.length);
  return center.map((x, i) => x + sigma * n[i]);
};

export const vectorLiteral = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`;

export function table(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  console.log(`| ${cols.join(' | ')} |`);
  console.log(`|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${cols.map((c) => String(r[c])).join(' | ')} |`);
  console.log();
}

export function save(name: string, data: Record<string, unknown>) {
  const dir = new URL('../results/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    new URL(`compare-${name}.json`, dir),
    JSON.stringify({ name, date: new Date().toISOString(), node: process.version, ...data }, null, 2) + '\n',
  );
}

/** Short description of a Postgres plan: the node types and index names, outermost first. */
export function planSummary(explainJson: unknown): string {
  const parts: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    const idx = node['Index Name'] ? ` (${node['Index Name']})` : '';
    parts.push(`${node['Node Type']}${idx}`);
    for (const child of (node['Plans'] as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
  };
  walk(((explainJson as Array<Record<string, unknown>>)[0]['Plan']) as Record<string, unknown>);
  return parts.join(' → ');
}
