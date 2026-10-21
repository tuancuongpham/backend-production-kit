# Performance

`node bench/run.ts <label>` measures the reference code's hot paths against the Docker Postgres and Redis from
`npm run verify:up`, and writes `bench/results-<label>.json`. The numbers below come from one Windows 11 laptop
(Node 24.16, Docker Desktop), before and after the 0.2.0 changes. Compare runs on the same machine, not absolute
numbers across machines.

| Benchmark | Before (0.1.0) | After (0.2.0) | Change |
|---|---|---|---|
| Redact one 50 KB log string with no `@` | 1,891 ms | 0.22 ms | ~8,600× faster |
| Redact structured log records (10 fields, 3 PII values) | 78,248 /s | 134,191 /s | +71% |
| Rate limiter, sequential checks over localhost | 2,628 /s | 2,593 /s | no measurable change |
| Webhook worker: drain 200 events, ~5 ms I/O per handler | 3,213 ms | 454 ms | 7.1× faster |

## What changed

- **Redaction.** The email pattern's unbounded local part (`[...]+@`) re-scanned to the end of the string from
  every position, which is O(n²) on long strings without `@`. Every quantifier is now bounded (RFC 5321 limits),
  each detector has a cheap `hint` pre-check that skips its regex when it can't match, short strings return
  immediately, and strings above `maxStringLength` (16 KiB) are truncated before scanning. The 50 KB case is
  both the regex fix and truncation; `verify/tests/latent-bugs.test.ts` checks the regexes alone, without
  truncation, at under 200 ms for 50 KB.
- **Webhook worker.** `concurrency` processes a claimed batch in parallel lanes, each row in its own
  transaction. The exactly-once guarantee is unchanged: 2 workers × concurrency 8 over 40 events still apply
  each event exactly once (enforced by a primary key in the test).
- **Rate limiter.** `EVALSHA` replaces `EVAL`, so the ~1 KB script is no longer sent with every check, with an
  `EVAL` fallback on `NOSCRIPT` after a Redis restart or failover. Over localhost the round trip dominates and
  there is no measurable difference; the saving is network bytes per request on a real network.

Raw results: [`bench/results-before.json`](../bench/results-before.json),
[`bench/results-after.json`](../bench/results-after.json).
