// PII redaction engines (CPU only — runs anywhere):
//   A. per-detector regexes with cheap hint pre-checks (shipped)
//   B. the same regexes without hints
//   C. one combined regex, single pass, named groups (leftmost match wins)
//   node bench/compare/redaction.ts
import { createRedactor, defaultDetectors, luhnValid } from '../../skills/pii-redaction/references/redact.ts';
import { save, table } from './lib.ts';

const A = createRedactor();
const B = createRedactor({ detectors: defaultDetectors.map(({ hint: _hint, ...d }) => d) });
// C: one regex needs one set of flags. It takes u (the email and id detectors match letters of any script), and the
// case-insensitive detectors keep that inside a modifier group, (?i:…).
const parts = defaultDetectors.map((d) => [d.name, d.pattern.flags.includes('i') ? `(?i:${d.pattern.source})` : d.pattern.source]);
const combined = new RegExp(parts.map(([n, s]) => `(?<${n}>${s})`).join('|'), 'gu');
const C = {
  redactString(s: string) {
    if (s.length < 5) return s;
    return s.replace(combined, (m, ...args) => {
      const groups = args.at(-1) as Record<string, string | undefined>;
      for (const [n] of parts) if (groups[n] !== undefined) return n === 'CARD' && !luhnValid(m) ? m : `[${n}]`;
      return m;
    });
  },
};

const typical = [
  'GET /v1/orders/42 200 183ms',
  'user 9f2c logged in from 10.0.0.12',
  'payment failed for alice@example.com: card declined',
  'retrying job 7 (attempt 3/8) after 1200 ms',
  'order 1234567890123 shipped to Hanoi',
  'sms sent to 0901234567',
  'cache miss key=tenant:42:route:/v1/chat',
  'slow query 1532ms: SELECT * FROM orders WHERE id = $1',
  'webhook evt_1NqX received from stripe',
  'Bearer token rejected for client 77',
];
const piiFree = ['worker started', 'cache warmed', 'job finished ok', 'connected to redis', 'shutdown requested', 'readiness ok'];
const heavy = Array.from({ length: 50 }, (_, i) =>
  Array.from({ length: 20 }, (_, j) =>
    j % 4 === 0 ? `mail user${i}.${j}@example.com` : j % 4 === 1 ? `call 09${String(10_000_000 + i * 31 + j).slice(1)}` : j % 4 === 2 ? 'card 4111 1111 1111 1111' : 'note lorem ipsum dolor',
  ).join('; '),
);
const workloads: Record<string, string[]> = { 'typical log lines': typical, 'no PII, no digits': piiFree, 'PII-heavy (2 KB, 20 values)': heavy };

const rate = (fn: (s: string) => string, inputs: string[], minMs = 400) => {
  for (let i = 0; i < 2000; i++) fn(inputs[i % inputs.length]);
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < minMs) for (const s of inputs) (fn(s), n++);
  return Math.round((n / (performance.now() - t0)) * 1000);
};

const rows: Array<Record<string, unknown>> = [];
for (const [w, inputs] of Object.entries(workloads)) {
  rows.push({
    workload: w,
    'A. hints (shipped) /s': rate(A.redactString, inputs),
    'B. no hints /s': rate(B.redactString, inputs),
    'C. single pass /s': rate(C.redactString, inputs),
  });
}
const all = Object.values(workloads).flat();
const mismatches = all.filter((s) => A.redactString(s) !== C.redactString(s));
table(rows);
console.log(`outputs differing between A and C: ${mismatches.length} of ${all.length}`);
for (const m of mismatches.slice(0, 3)) console.log(`  A: ${A.redactString(m).slice(0, 120)}\n  C: ${C.redactString(m).slice(0, 120)}`);
save('redaction', { rows, mismatches: mismatches.length, inputs: all.length });
