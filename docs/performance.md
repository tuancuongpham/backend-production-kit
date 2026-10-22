# Performance

Two kinds of measurements:

- **Approach comparisons** (`bench/compare/`, 0.3.0). For each hot path, the realistic alternatives run side by
  side on the same data. The skill now ships the winner; the tables show by how much it won and what was traded.
- **Before/after** the 0.2.0 fixes (`node bench/run.ts`), at the end.

## How these were measured

```bash
npm run verify:up
npm run bench:docker -- bench/compare/webhook-claim.ts   # any script in bench/compare/
node bench/compare/redaction.ts                          # CPU-only scripts can run on the host
```

Each script prints a markdown table and writes `bench/results/compare-<name>.json`. Numbers come from one
Windows 11 laptop running Docker Desktop, Postgres 17 + pgvector 0.8 and Redis 7. Compare rows within a table,
not absolute numbers across machines.

**Run database benchmarks inside the Docker network.** `bench:docker` runs the script in a `node:24-alpine`
container on the compose network. From the host, Docker Desktop's port forwarder adds about 44 ms to any message
of 16 KB or more ([`transport.ts`](../bench/compare/transport.ts)):

| Query parameter size | From the host | Inside the Docker network |
|---|---|---|
| 1–15 KB | 0.45–0.60 ms | 0.23–0.55 ms |
| 16–64 KB | **43.9–45.6 ms** | 0.27–0.71 ms |

That is the signature of Nagle's algorithm meeting a delayed ACK, and it sits in the forwarder: node-postgres
already sets `TCP_NODELAY` on its own socket, and the same queries inside the network show no cliff. It cost us one
wrong conclusion. The first semantic-cache run said the new lookups were 40 ms slower, but only because their probe
vector was a 31 KB text parameter. Linux hosts and real deployments don't have this artifact.

## Approach comparisons (0.3.0)

### Semantic cache lookup · `llm-gateway`

The question is "find the nearest cached answer *of this tenant*". The data has 100 small tenants (100–120 entries
each) and one big tenant (5,020). Twenty popular questions are cached by all 101 tenants, as paraphrases with
cosine ≈ 0.99 to each other. A hit means this tenant's own entry with similarity ≥ 0.95.

| Scope | Strategy | Hits | p50 | p95 |
|---|---|---|---|---|
| big tenant | A. HNSW index + `WHERE scope` (0.2.0) | **4/20** | 0.81 ms | 1.72 ms |
| big tenant | B. HNSW + iterative scan (`semanticSearch: 'ann'`) | 20/20 | 2.27 ms | 3.67 ms |
| big tenant | C. exact within the scope (default) | 20/20 | 8.39 ms | 9.67 ms |
| small tenant | A. HNSW index + `WHERE scope` (0.2.0) | 20/20 | 0.52 ms | 1.06 ms |
| small tenant | B. HNSW + iterative scan | 20/20 | 1.70 ms | 2.28 ms |
| small tenant | C. exact within the scope (default) | 20/20 | **0.45 ms** | 0.65 ms |

| Cache save | p50 | p95 |
|---|---|---|
| with the HNSW index | 9.18 ms | 11.19 ms |
| without it | **1.24 ms** | 1.81 ms |

A is fast because it is wrong. The planner walks the HNSW index, which returns its `ef_search` (40) nearest rows
across *all* tenants, and filters by scope afterwards. When 100 other tenants cached the same popular question,
those 40 slots are full of other tenants' copies, and the big tenant gets a miss. Each miss is a full-price model
call, and it happens exactly for the questions that are asked most.

**Shipped:** exact search by default. It is correct everywhere, needs no HNSW index (saves are 7× cheaper) and is
the fastest choice for typical scope sizes. Switch to `'ann'` past a few thousand entries per scope, on
pgvector ≥ 0.8. Building the index took 26 s for 17,020 rows. On a full table in Docker it may run in parallel and
need more than the default 64 MB `/dev/shm`.

### Where the vector is stored · `llm-gateway`, `multitenant-postgres`

Exact search reads every live vector of the scope. pgvector's type defaults to `STORAGE EXTERNAL`, so a 1536-dim
vector (6 KB) lives out of line in the TOAST table, and every row read costs extra lookups
([`vector-storage.ts`](../bench/compare/vector-storage.ts), exact-search p50 by scope size):

| Storage | 120 rows | 1,000 rows | 5,000 rows | Same top-1 as A | Size on disk | Insert p50 |
|---|---|---|---|---|---|---|
| A. `vector`, default (TOAST) | 0.73 ms | 4.36 ms | 20.3 ms | — | 130 MB | 1.54 ms |
| B. `vector`, `STORAGE MAIN` | **0.34 ms** | 1.50 ms | 8.88 ms | 20/20 | 128 MB | 1.31 ms |
| C. `halfvec`, `STORAGE MAIN` | 0.48 ms | **1.20 ms** | **6.38 ms** | 20/20 | 65 MB | 1.37 ms |

**Shipped:** `ALTER TABLE llm_semantic_cache ALTER COLUMN embedding SET STORAGE MAIN`. It is one line, works on
any pgvector version, gives identical results and is 2.1–2.9× faster. `halfvec` gains another 20–30% on large
scopes and halves the storage, but changes the column type and needs pgvector ≥ 0.7; it is the right choice for
3072-dim models, whose `vector` doesn't fit in a row.

### Sending the embedding · `llm-gateway`, `multitenant-postgres`

What `[${v.join(',')}]` costs, compared with a binary parameter in pgvector's wire format
([`vector-params.ts`](../bench/compare/vector-params.ts), 1536 dims, lookup in a 120-row scope, shipped schema):

| Encoding | Bytes per vector | Lookup p50 | Insert p50 | Max similarity difference |
|---|---|---|---|---|
| A. text, JS default formatting (0.2.0) | 32,585 | 1.60 ms | 0.95 ms | — |
| B. text, 9 significant digits | 20,983 | 1.43 ms | 1.15 ms | 5.4e-9 |
| C. binary (`vectorParam`) | **6,148** | **0.46 ms** | **0.29 ms** | 0 |

The cost of text is mostly server-side float parsing, so shorter text doesn't help. A second run gave the same
picture (C: 0.51 / 0.31 ms; A: 1.30 / 1.04 ms). Inserts ran with `synchronous_commit = off`, so that WAL flush time
on the virtual disk doesn't drown out the encoding.

**Shipped:** `vectorParam()` in both skills. Combined with inline storage, a small-scope lookup went from 2.1 ms in
0.2.0 to 0.46 ms.

### Webhook claim under a backlog · `webhook-ingestion`

The worker's claim must find due rows and rows stuck in `processing` after a crash. The table holds 300,000 `done`
rows and 20 stuck rows; the due backlog grows ([`webhook-claim.ts`](../bench/compare/webhook-claim.ts), claim of
10 rows):

| Due backlog | 0.2.0: one `pending OR stuck` filter | 0.3.0: stuck branch + due branch |
|---|---|---|
| 2,000 | 1.16 ms | 0.58 ms |
| 50,000 | 13.9 ms | 0.61 ms |
| 200,000 | **55.6 ms** (p95 96.8 ms) | **0.58 ms** (p95 0.98 ms) |

The plans explain it. The 0.2.0 claim is `Sort → Bitmap Heap Scan → BitmapOr`: no index can return an `OR` of two
partial indexes in `next_attempt_at` order, so every claim fetches and sorts the whole due backlog. The 0.3.0
claim is an `Append` of two `Limit → LockRows → Index Scan` branches and stops after 10 rows. So the old worker
slowed down in proportion to the backlog, which is exactly when it needed to be fastest.

**Shipped:** the two-branch claim, still one statement and one round trip.

### Webhook worker layout · `webhook-ingestion`

There are 8 slots of parallelism to spend. Each run drains 200 events, either with uniform 5 ms handlers or with
every 20th handler taking 200 ms (a slow provider call):

| Layout | Uniform 5 ms | Every 20th takes 200 ms |
|---|---|---|
| 1 loop, batch 50, `concurrency: 8` | 247 ms | 1,040 ms |
| 1 loop, batch 8, `concurrency: 8` | 275 ms | 2,247 ms |
| 8 independent loops, batch 1 | 318 ms | 670 ms |
| 8 independent loops, batch 4 | 242 ms | 608 ms |
| **shipped `run({ loops: 8 })`, batch 4** | **214 ms** | **577 ms** |

A batch processed in lanes ends only when its slowest row does. Meanwhile the other lanes sit idle, and nobody
claims more work. Independent loops keep claiming. Small batches matter too, because the rows a loop has claimed
wait behind its current one. With uniform handlers, all layouts are within about 30% of each other.

For comparison, one loop with batch 50 drains 200 uniform events in 1,542 ms at `concurrency: 1`, 248 ms at 8 and
129 ms at 32 (pool of 20).

**Shipped:** `worker.run({ loops, signal })`. It runs independent loops, and stopping waits for the claimed rows, so
a deploy no longer strands rows in `processing` for `stuckAfterSec`.

### Claiming a job · `job-queue`

Three table designs for a job queue ([`job-queue.ts`](../bench/compare/job-queue.ts)). Each table holds 1,000,000
finished jobs and 100,000 reminders scheduled for tomorrow. The timing covers only the claim statement, which takes
10 jobs:

| Scenario | A. one table, index on `run_at` | B. one `pending` state, partial index on (queue, priority, run_at) | C. shipped: `scheduled` → `available` |
|---|---|---|---|
| Nothing due (an idle poll) | 72.9 ms | 3.42 ms | **0.30 ms** |
| 10,000 jobs due | 72.5 ms | 3.55 ms | **0.49 ms** |

- **A** can't skip history. `run_at <= now()` matches every finished job, so Postgres reads the whole table and
  sorts (`Sort → Seq Scan`) on every claim and every idle poll. That repeats from every loop, every second, and
  grows with the table.
- **B** keeps history out of the index, but due and delayed jobs share it. To find a due job, or to learn that
  there is none, the claim walks past every delayed job at a better priority: here all 100,000 reminders.
- **C** gives delayed jobs and retries their own state. The claim index holds only due jobs, in claim order, so
  the claim reads 10 index entries whatever else is in the table.
- C pays for promotion and lease rescue with `maintain()`, two statements that cost 1.0 ms (p95 3.2 ms) when there
  is nothing to do. The worker runs it about once a second per instance.

**Shipped:** C.

### Outbox relay · `outbox-pattern`

The relay marks each published message. The run publishes 5,000 messages to an instant in-memory broker, which
isolates the relay's own database cost:

| Variant | Total | Messages/s |
|---|---|---|
| A. one `UPDATE` per message (0.2.0) | 1,559 ms | 3,207 |
| B. one `UPDATE … WHERE id = ANY($1)` per batch of 100 | 173 ms | 28,955 |
| B. the same, batch 500 | 64 ms | 78,022 |
| C. shipped `createRelay()`, batch 100 | 188 ms | **26,609** |

The crash behaviour is identical: the marks become durable only at `COMMIT` in every variant, so a crash mid-batch
re-publishes the batch and consumers dedup. C matches B; the per-message publish timeout costs nothing measurable.

**Shipped:** batch marking (8.3×). Batch size stays at 100. With a real broker, publish latency dominates, and
bigger batches mean longer lock holds and bigger re-publishes after a crash.

### LLM budget reservation · `llm-gateway`

The reservation runs before every paid model call:

| Variant | p50 | p95 | Reservations/s, 16 parallel (median of 3) | Granted of 200 against $50 | Oversized first call refused |
|---|---|---|---|---|---|
| A. `INSERT … DO NOTHING`, then a conditional `UPDATE` (0.2.0) | 1.41 ms | 3.01 ms | 5,402 | 50 | yes |
| B. one conditional upsert | 1.18 ms | 2.71 ms | 7,074 | 50 | yes |
| C. shipped `pgBudget()` (= B) | **1.13 ms** | 2.73 ms | **7,405** | 50 | yes |

**Shipped:** the upsert. It has one round trip instead of two, is exact under contention, and cuts latency by
16–20% while raising throughput by 31–37%.

### Row-Level Security · `multitenant-postgres`

There are 200 tenants × 1,000 documents. First, how the policy reads the tenant id, timing only the query inside
the tenant's transaction:

| Policy expression | `count(*)` p50 | Top-20 page p50 | Plan for `count(*)` |
|---|---|---|---|
| `tenant_id = current_tenant_id()` (shipped; SQL, `STABLE`) | 0.32 ms | 1.39 ms | Index Only Scan |
| `tenant_id = (SELECT current_tenant_id())` | 0.29 ms | 1.41 ms | Index Only Scan |
| the expression written out | 0.25 ms | 1.28 ms | Index Only Scan |
| a plpgsql function without a volatility marker (`VOLATILE`) | **119.8 ms** | **121.9 ms** | **Seq Scan** |
| no RLS, explicit `WHERE` (superuser baseline) | 0.26 ms | 1.47 ms | Index Only Scan |

RLS with a `STABLE` function costs about nothing. A `VOLATILE` one, which is plpgsql's default, can't be used as an
index condition, so every RLS query scans the table: 380× slower here.

Second, what a request pays end to end for a primary-key lookup:

| Request shape | p50 | p95 |
|---|---|---|
| A. `BEGIN` / `set_config` / query / `COMMIT`: 4 round trips (0.2.0) | 0.59 ms | 0.82 ms |
| B. `BEGIN; set_config` in one call / query / `COMMIT`: 3 round trips | **0.48 ms** | **0.69 ms** |
| floor: one query, explicit `WHERE`, no transaction | 0.19 ms | 0.29 ms |

**Shipped:** `withTenant` uses shape B. The id is inlined into that call only after a strict UUID check, and a test
feeds it injection strings. The policy function stays `LANGUAGE sql STABLE`, and the skill now warns about
`VOLATILE`. The 19% shown here comes from a sub-millisecond network; across availability zones each round trip
costs more, so the saving grows.

### Claiming an idempotency key · `idempotency-keys`

Three ways to claim a key for a database effect ([`idempotency.ts`](../bench/compare/idempotency.ts)). The cost per
request is sequential, with a handler that inserts one order:

| Variant | First request p50 | Replay p50 |
|---|---|---|
| no idempotency (`BEGIN`, `INSERT`, `COMMIT`) | 1.65 ms | — |
| A. check, then insert | 2.13 ms | 0.52 ms |
| B. insert first, duplicates wait on the row | 2.24 ms | 0.71 ms |
| C0. first draft of C: claim and read the record in one statement | 2.55 ms | 0.67 ms |
| **C. shipped: advisory try-lock + claim, 409 at once** | 2.20 ms | 0.84 ms |

Then 20 copies of one request arrive at once, and the handler takes 200 ms:

| Variant | Handler runs | Answers: first / replay / 409 / error | Connection time held by the 19 duplicates | Slowest duplicate answer |
|---|---|---|---|---|
| A. check, then insert | **20** | 1 / 0 / 0 / **19** | 4,075 ms | 215 ms |
| B. insert first, duplicates wait | 1 | 1 / 19 / 0 / 0 | **4,132 ms** | 218 ms |
| **C. shipped** | 1 | 1 / 0 / 19 / 0 | **130 ms** | **8 ms** |

Across five runs, first-request times moved by a few tenths of a millisecond. A, B and C stayed within that noise of
each other, C0 was slower in every run, and the burst table didn't change. All three cost the same per request:
two statements, about half a millisecond here. They differ under duplicates:
- A runs the handler for every copy, and 19 copies then fail on the primary key with a 500 after doing the work. A
  database effect rolls back, but an email or a charge would have gone out 20 times.
- B is correct, but every duplicate parks a pool connection until the first request finishes. In a retry storm that
  is the whole pool.
- C answers duplicates in milliseconds, and they come back after `Retry-After` for the replay.

The first draft read the existing record in the same statement as the claim (a CTE and a join). That saved a round
trip on replays (0.67 against 0.84 ms) but made every first request heavier. Replays are the rare path, so the
claim stays lean and a second statement reads the record only when nothing was claimed.

**Shipped:** C.

### Rate limiter throughput · `rate-limiting`

| ioredis client | Limiter checks/s, sequential | Limiter, 64 concurrent | Bare `EVALSHA`, 64 concurrent | `PING`, 64 concurrent | Redis µs per script call |
|---|---|---|---|---|---|
| defaults | 6,301 | **57,080** | 72,242 | 73,234 | 9.3 |
| `enableAutoPipelining: true` | 5,908 | 50,681 | 56,339 | 198,910 | 8.7 |

Redis executes the bucket script in about 9 µs, so one primary can serve at most ~100k checks/s across all
instances. A single Node process tops out near 57k checks/s, and the timeout race costs about 20% of that compared
with a bare `EVALSHA`. Auto-pipelining makes `PING` 2.7× faster but `EVALSHA` 22% slower.

**Shipped:** unchanged, measured. The client defaults stay. No app instance serves 57k HTTP requests per second, so
the limiter is not the bottleneck, and past one Redis primary the answer is sharding subjects over Redis Cluster
(keys already carry hash tags).

### PII redaction engine · `pii-redaction`

Throughput in strings per second, on CPU only:

| Workload | A. per-detector regexes + hints (shipped) | B. same without hints | C. one combined regex, single pass |
|---|---|---|---|
| typical log lines | **1,454,888** | 807,722 | 1,081,264 |
| no PII, no digits | **5,731,081** | 1,222,583 | 3,456,237 |
| PII-heavy (2 KB, 20 values) | **114,723** | 49,036 | 34,320 |

A and C produced identical output on all 66 inputs.

**Shipped:** unchanged, measured. The cheap hints skip most detectors on most lines, which a single combined
pattern can't do.

## Before/after 0.2.0

`node bench/run.ts <label>` measures the reference code's hot paths against the Docker Postgres and Redis from
`npm run verify:up`, and writes `bench/results-<label>.json`. These numbers came from the host (Node 24.16), before
and after the 0.2.0 changes:

| Benchmark | Before (0.1.0) | After (0.2.0) | Change |
|---|---|---|---|
| Redact one 50 KB log string with no `@` | 1,891 ms | 0.22 ms | ~8,600× faster |
| Redact structured log records (10 fields, 3 PII values) | 78,248 /s | 134,191 /s | +71% |
| Rate limiter, sequential checks over localhost | 2,628 /s | 2,593 /s | no measurable change |
| Webhook worker: drain 200 events, ~5 ms I/O per handler | 3,213 ms | 454 ms | 7.1× faster |

- **Redaction.**
  - The email pattern's unbounded local part (`[...]+@`) re-scanned to the end of the string from every
    position, which is O(n²) on long strings without `@`.
  - Now every quantifier is bounded (RFC 5321 limits), each detector has a cheap `hint` pre-check that skips its
    regex when it can't match, short strings return immediately, and strings above `maxStringLength` (16 KiB) are
    truncated before scanning.
  - The 50 KB result combines the regex fix and truncation. `verify/tests/latent-bugs.test.ts` checks the regexes
    alone, without truncation, at under 200 ms for 50 KB.
- **Webhook worker.** `concurrency` processes a claimed batch in parallel lanes, each row in its own transaction.
  0.3.0 replaced this as the recommended layout with `run({ loops })`; see above.
- **Rate limiter.** `EVALSHA` replaces `EVAL`, so the ~1 KB script is no longer sent with every check. It falls
  back to `EVAL` on `NOSCRIPT` after a Redis restart or failover.

## Raw results

- `bench/results/compare-*.json`: one file per comparison above, including the query plans.
- [`bench/results-before.json`](../bench/results-before.json), [`bench/results-after.json`](../bench/results-after.json): 0.2.0 before/after.
