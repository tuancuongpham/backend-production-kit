# Changelog

## 0.5.0 — 2026-10-22

### Fixed — latent bugs, round 3
Every reference file was read again, and each suspected failure was written down as a hypothesis and as a test of
the behaviour the skill promises. All 34 tests failed on 0.4.0 and pass now
(`verify/tests/latent-bugs-round3.test.ts`). One more hypothesis was refuted: an any-word tsquery built with
`quote_literal` can't break on user input, because Postgres's `simple` parser never yields a lexeme with a
backslash or a quote.
- `webhook-ingestion`: a handler slower than `stuckAfterSec` was claimed again and run alongside the first, and both
  credited the payment. A worker that had lost its event could also put it back to `pending` after another worker
  finished it. Each claim now carries a `lease_id`, and the handler's transaction locks its own row as the lease
  holder: `SKIP LOCKED` then passes over it, and a worker that lost its row gets `lost`.
- `llm-gateway`:
  - a cache or budget-store error after the model answered was treated as a provider failure: the fallback was
    called (a second paid answer), the healthy provider's breaker counted a failure, and the reservation stayed.
    After the answer, settling and caching are now best effort, reported through the new `onError`.
  - A cache store that was down failed every request; it is now skipped.
  - When a breaker's cooldown ended, every waiting request called the dead provider (10 calls instead of 1 probe).
  - A request already cancelled was still sent.
  - Fallback answers were cached for 24 h; now 5 minutes (`fallbackCacheTtlSec`).
- `llm-tool-safety`:
  - the "untrusted content" taint lived in process memory, so the agent's next turn (a new request, maybe another
    instance) ran writes without approval. It is now stored per conversation (`tool_sessions`, a `TaintStore` port).
  - A retried approved call was refused as "approval already used" instead of replaying its result.
  - `decide()` accepted an approver from another tenant; it now takes `{ tenantId, userId }`.
  - A tool call left `running` by a crash blocked its id forever; it is taken over after `staleRunSec`.
- `idempotency-keys`: a request whose stale claim had been taken over could delete the new owner's claim when it
  failed, so a third retry ran the charge again. Claims carry a `claim_token` now.
- `job-queue`: in a batch, only the running job was heartbeated. The jobs waiting behind it expired, were rescued,
  and could go dead without ever running. Stopping a worker also ran out the whole batch; it now hands unstarted
  jobs back without spending their attempt.
- `data-retention-and-erasure`:
  - two instances processing the same request could reopen it after it was completed and its subject id cleared,
    and it was then retried forever with `erase(null)`. Requests are now leased.
  - `processPending` miscounted completions when more than one batch was open.
  - An `anonymize` entry that left a personal column in place was accepted; the inventory is now checked at startup.
- `agent-safe-db`: the executor's own pool had no `error` listener (an idle connection ended by the server crashed
  the process), no connect timeout (a black-holed database hung every call) and no client-side query timeout.
- `rate-limiting`: the breaker had no half-open state (20 checks probed a dead Redis instead of 1); `check()` now
  refuses a cost outside (0, capacity], since a negative cost added tokens.
- `cache-stampede`: a hit returned a different shape than the miss that filled it (a `Date` came back as a string);
  a value JSON can't encode failed the request; a black-holed Redis cost 50 ms on every request. Values now go
  through a `Codec` on every path, unencodable values are served uncached, and Redis calls have a breaker.
- `sse-streaming`: event ids restarted at 1 with the process, so a client reconnecting after a deploy silently
  missed the new process's first events. Ids now start from the clock and an old id gets `reset`.
- `multitenant-postgres`: the RLS audit accepted a `USING (true)` policy; a third query flags permissive policies
  that don't filter by tenant.
- `rag-evals`: a retriever returning the same id twice scored recall 2; a golden set with new hard questions failed
  the gate (runs are now compared on shared queries, and added or removed ones are listed); `fillPrompt` mangled
  answers containing `$&` or `$'`.
- `llm-observability`: a reply with `content: null` (a tool call) made the redactor throw and turned a successful
  call into an error; recording can't throw any more. `otel-setup.ts` registered a SIGTERM listener that only
  flushed, which kept a service without its own handler running until SIGKILL; it exports `shutdownTelemetry`
  instead.
- `pii-redaction`: a custom detector without the `g` flag redacted only the first match, and a hint with it skipped
  every other string. Both are refused at startup.
- `zero-downtime-migrations`: a backfill batch that lost a deadlock failed the whole backfill; it is retried, and a
  final error carries `lastId`. The linter now flags `ADD COLUMN … NOT NULL` without a default.
- Found while refactoring: `adr-writer`'s `new-adr.mjs` filled its template with `replaceAll`, so a title with `$&`
  came out garbled.
- Tests: the outbox resilience test raced two network events, Toxiproxy's API answer and the relay socket's close,
  and once saw 6 sends instead of 4 on CI. The relay can only stop for a drop it has seen. The test now waits until
  the connection noticed, and the docs say "once it notices" instead of "as soon as the connection dies". The
  round-3 idempotency test waits for each claim instead of sleeping a guessed 100 ms.

### Changed — architecture
- Stateful components are classes behind the same `createX()` factories: `OutboxRelay`, `InboxWorker`, `JobWorker`,
  `Scheduler`, `IdempotencyKeys`, `LlmGateway`, `ToolGuard`/`ToolSession`, `DataLifecycle`, `AgentDb`,
  `RateLimiter`, `ReadThroughCache`, `SseStream`, `ReplayBuffer`, `Toxiproxy`. Pure logic stays functions, and the
  redactor and the hardened server stay closures, because their functions are passed around detached.
- A shared kernel in `shared/` (`withClient`/`withTransaction`, `CircuitBreaker`, `withTimeout`, `runLoops`),
  vendored into each skill that imports it. `npm run sync:shared` copies it, and `npm run validate` fails on a copy
  that drifts.
- `docs/architecture.md`: when to use a class, a function or a closure; the ports; the nine invariants.
- New: `OutboxRelay#run()`, the relay loop the other workers already had.
- To upgrade from 0.4.0:
  - run the SQL files again: they add `webhook_inbox.lease_id`, `idempotency_keys.claim_token`,
    `tool_results.claim_token`, the `tool_sessions` table, and `erasure_requests.lease_id`/`locked_until`;
  - `ToolGuard#decide` takes `{ tenantId, userId }`, and `ToolSession#markUntrusted` returns a promise;
  - `pgUsageSink` rejects on a failed write (the gateway hands it to `onUsageError`);
  - cache entries have a new format: old ones read as misses and are overwritten. Bump the prefix version to drop
    them at once.

### Tooling
- `npm run typecheck`: strict TypeScript over the reference code and the shared kernel, with `erasableSyntaxOnly`,
  which rejects what Node's type stripping can't run (enums, namespaces, parameter properties). Node never checks
  types, so before this a type error in reference code went unnoticed. It now runs in CI and in the release job.
  The code passed it as is.
- `npm run sync:shared`, and `npm run validate` checks that every vendored copy of the shared kernel is identical.

### Performance
- The semantic cache lookup in shadow mode runs beside the model call: 108 ms per request instead of 206 ms
  (100 ms embedding, 100 ms model).
- 20 requests through the cache with Redis black-holed: 181 ms instead of 1,236 ms.
- Re-measured inside the Docker network after the refactor: the outbox relay, rate limiter, webhook claim and
  drain, job claim and idempotency stayed within run-to-run noise of 0.4.0. The webhook worker makes one more round
  trip per event (locking its row): about 3% on a drain with 5 ms handlers.
- One regression was caught by those measurements and fixed before release. Idempotency replays went from 0.84 ms
  to 1.75 ms, because the refactored early return committed instead of rolling back. `ON CONFLICT DO UPDATE` locks
  the existing row even when it changes nothing, so the commit cost a WAL flush. It rolls back again (0.82 ms).

## 0.4.0 — 2026-10-22

### New skill: `job-queue`
Background jobs on Postgres. A job is enqueued in the business transaction and claimed with SKIP LOCKED. While it
runs it is leased, and heartbeats renew the lease. A failing job retries with jittered backoff, then becomes a dead
letter that `retryDead` can replay. The queue also supports unique jobs, delayed jobs, and recurring jobs that fire
exactly once across instances; `run()` stops gracefully, and finished jobs are pruned.
- 12 tests against real Postgres. They cover a worker that dies after claiming (the job runs exactly once more), a
  worker frozen past its lease (its late result is discarded), a handler that ignores its abort signal, and three
  scheduler instances ticking at once.
- Benchmarked three table designs next to 1,000,000 finished jobs and 100,000 delayed ones. An idle poll costs
  73 ms with an index on `run_at`, 3.4 ms with one `pending` state, and 0.3 ms with the shipped separate
  `scheduled` and `available` states.

### New skill: `zero-downtime-migrations`
Change a live schema without stalling the app.
- `runStep` runs each step under `lock_timeout`, retries when the lock isn't granted, and drops the `INVALID`
  index a failed `CREATE INDEX CONCURRENTLY` leaves behind.
- `backfill` updates in short batches and resumes where an interrupted run stopped.
- `lintMigration` flags statements that lock the table or break the version of the app still running.
- `patterns.md` has the expand/contract recipes, including the RLS retrofit for `multitenant-postgres`.
- 7 tests against real Postgres, including a DDL statement queued behind a long transaction, an insert during an
  index build, and `SET NOT NULL` shown to skip its scan after a validated `CHECK`.
- Benchmarked on a 1M-row table: a read behind a blocked `ALTER` waited 52 ms instead of 1 s, and an insert during
  an index build waited 2 ms instead of 1.5 s.

### New skill: `cache-stampede`
A Redis read-through cache that holds when a hot key expires: single-flight per process, a Redis lock across
instances, stale-while-revalidate, jittered TTLs, cached misses, tenant-scoped keys, and failing open when Redis is
down.
- 8 tests against real Redis, including three instances missing at once (one origin call), an instance that died
  holding the lock, and an origin outage while a stale value is served.
- Benchmarked with 4 instances × 50 requests: 1 origin call instead of 200 with plain cache-aside, and 0.7 ms
  instead of 141 ms while the entry is stale.

### New skill: `llm-tool-safety`
Guardrails for the tools an agent can call.
- Tools have tiers (read, write, destructive) and strict argument schemas. The tenant comes from the session.
- Once untrusted content is in the context, writes need a human approval bound to the exact arguments, single-use
  and expiring. Destructive tools always need one, optionally from a second person.
- Calls run once per `tool_call_id`, and every call is audited.
- 7 tests against real Postgres, including a poisoned document that asks for a refund and a deletion: nothing runs.

### New skill: `rag-evals`
Retrieval metrics (recall@k, MRR, nDCG, hit rate) with slices, a CI gate that lists the queries that broke, and an
LLM-judge harness whose agreement with human labels is measured before its scores are trusted.
- 4 tests, including the gate catching a real regression in `hybridSearch`, and a judge with 83% accuracy that
  still passed a false claim (kappa 0.57).

### New skill: `data-retention-and-erasure`
One inventory of where each person's data lives drives four things:
- erasure: every table in one transaction, external stores retried until done, and a durable request record that
  keeps only a peppered hash once complete;
- access exports;
- batched retention;
- a CI audit for personal columns nobody classified, Vietnamese column names included.

6 tests against real Postgres and Redis. After an erasure, a scan of every text column finds none of the person's
identifiers, and invoice amounts are kept.

### New skill: `resilience-testing`
Toxiproxy between the app and its dependencies, a small client to add latency, black holes, resets and outages from
tests, and a scenario catalog with the expected behaviour per fault. Toxiproxy now runs in the verify stack and in
CI. 6 tests run the kit's own reference code through it, and found:
- a server-side `statement_timeout` doesn't bound a slow network; a client-side `query_timeout` does;
- a pool without `connectionTimeoutMillis` waits forever for a black-holed database;
- an ioredis client without its offline queue fails every command until it has connected;
- the outbox relay bug below.

### New skill: `slo-alerting`
SLOs as code. `prometheusRules` generates recording rules and multi-window, multi-burn-rate alerts, `promtool`
checks and unit-tests them in CI, and a simulator shows what an incident would trigger.
- 5 tests: a 10% error rate pages in 9 minutes; a 0.2% slow burn opens a ticket after 36 hours and never pages;
  normal noise triggers nothing; Prometheus itself fires and resolves the generated rules as designed.

### Fixed
- `multitenant-postgres`: the keyword side of `hybridSearch` required every word of the query, so questions typed
  as sentences matched nothing there (0 of 10 in the eval). It now falls back to any word when nothing matches every
  word: 10 of 10, with search-box ranking unchanged.
- `outbox-pattern`: when the database connection died mid-batch, the relay kept publishing the rest of the batch,
  and all of it went out again on the next run. It now stops before the next publish.
- `rate-limiting`, `cache-stampede` and the service-hardening checklist now say to connect Redis before reporting
  ready when the offline queue is off. The checklist also requires `connectionTimeoutMillis` and a client-side
  `query_timeout` on Postgres pools.

### Docs
- README: an "Incidents it is tested against" table, and the new comparisons.
- `docs/performance.md`: schema changes on a live table, a hot key expiring under load, the keyword side of hybrid
  search.
- `docs/roadmap.md`: all nine ranked candidates are built.

### CI/CD
- Toxiproxy runs as a service in the CI and release jobs. The SLO test runs `promtool` from the official
  Prometheus image.

## 0.3.0 — 2026-10-21

### New skill: `idempotency-keys`
Stripe-style `Idempotency-Key` handling in Postgres for retried POSTs and agent tool calls. A retry gets the
first response back instead of a second order, charge or email. A duplicate arriving mid-flight gets 409, and a key
reused for another request gets 422.
- `runIdempotent` covers effects in the same database: claim, effect and stored response commit in one
  transaction, so a crash leaves nothing behind.
- `runIdempotentExternal` covers payment providers and other services: the claim commits first, the handler gets a
  `downstreamKey`, and a claim left by a dead process is taken over after `staleAfterSec`.
- 11 tests against real Postgres, including 20 concurrent copies of one request, a connection killed mid-handler,
  and a process that died after charging.
- Benchmarked against the two versions agents usually write:
  - check-then-insert ran the handler 20 times for 20 duplicates;
  - insert-and-wait held about 4 s of pooled connections;
  - the shipped try-lock answers duplicates with 409 in 8 ms and holds 0.13 s.

### Fixed — latent bugs, round 2
Each bug was reproduced by a failing test first (`verify/tests/latent-bugs-round2.test.ts`), then fixed.
- `llm-gateway`: with an HNSW index, the semantic cache filtered by tenant *after* the index returned its 40
  nearest rows across all tenants. A question many tenants had cached crowded out this tenant's own entry: 4 hits
  out of 20 for a big tenant, each miss a paid model call. Search is now exact within the scope by default, and
  `semanticSearch: 'ann'` uses pgvector 0.8 iterative scans.
- `webhook-ingestion`: the claim's `pending OR stuck` filter couldn't use either index's order, so every claim
  sorted the whole due backlog: 56 ms per claim at 200,000 events due. Two index-ordered branches now keep it at
  0.6 ms regardless of backlog.
- `outbox-pattern`: a publish call that never returned held the relay's transaction and advisory lock forever,
  silently stopping all delivery. New `publishTimeoutMs` (default 10 s).
- `service-hardening`: oversized uploads got a connection reset instead of the 413 (chunked and declared
  length), so clients retried the whole upload. The server now stops reading, delivers the 413 with
  `Connection: close`, and closes after `rejectLingerMs`.
- `sse-streaming`: a stalled feed subscriber buffered every event (40 MB in the test). `serveFeed` now drops a
  client more than `maxQueue` events behind; it reconnects with `Last-Event-ID`.
- `rate-limiting`: `refillPerSec: 0` made the Lua script divide by zero, so every check errored and the limiter
  ran in its failure mode. Non-positive or non-finite `capacity`/`refillPerSec` are rejected at startup.
- `llm-observability`: prompt and response attributes were unbounded (a 240 KB RAG prompt became one attribute).
  New `maxContentChars` (default 32 KiB) with a truncation marker.
- Retention: `pruneInbox` (done rows only, never dead letters, window longer than the provider's retry period)
  and `pruneLlmCache` delete in batches through new indexes; the tables used to grow forever.
- Every function that checks a client out of the pool crashed the **whole Node process** when Postgres ended the
  connection between two queries. That covered `withTenant`, `relayOnce`, `consumeOnce`, the webhook worker, the
  `ann` cache lookup and the agent DB tool. The trigger can be a failover, `pg_terminate_backend`, or
  `idle_in_transaction_session_timeout` during a slow handler or publish.
  - Cause: node-postgres emits `error` on the checked-out client, and nothing listened.
  - Fix: each function now listens while it holds the client. Only that request fails, and the pool drops the dead
    client.
  - Tests: `verify/tests/connection-loss.test.ts` kills the connection inside each one, and it fails without the fix.
  - The service-hardening checklist now also requires `pool.on('error')`; an idle pooled client hits the same crash.

### Performance — approach comparisons (`bench/compare/`, tables in docs/performance.md)
Each hot path's alternatives were measured side by side inside the Docker network, and the winner shipped:
- Embeddings are sent as binary parameters (`vectorParam`) in `llm-gateway` and `multitenant-postgres`: about 3×
  faster lookups and inserts, 6 KB instead of 32 KB per 1536-dim vector, identical results.
- `llm_semantic_cache.embedding` is stored in the row (`SET STORAGE MAIN`): exact search 2–3× faster. Combined
  with binary parameters, a small-scope lookup went from 2.1 ms to 0.46 ms.
- The HNSW index on the semantic cache is now opt-in: it made every cache save 7× slower and the default search
  never uses it.
- `webhook-ingestion`: new `worker.run({ loops, signal })`, with independent loops and a graceful stop that
  finishes claimed rows. It drains 1.8× faster than lanes over one batch when some handlers are slow.
- `outbox-pattern`: one `UPDATE` per batch instead of per message: 8.3× relay throughput, same crash behaviour.
- `llm-gateway`: budget reservation is one conditional upsert instead of two statements: 20% lower latency,
  37% more throughput, still exact under contention.
- `multitenant-postgres`: `withTenant` sends `BEGIN` and `set_config` in one round trip (the tenant id is
  validated as a UUID first, and a test feeds it injection strings), 19% faster per request. Measured that RLS
  itself costs about nothing with a `STABLE` function, and 380× more with a `VOLATILE` one; the skill now warns.
- Measured and kept as they were: the rate limiter's ioredis defaults (auto-pipelining was 11% slower for
  `EVALSHA`) and per-detector redaction with hints (1.3–4.7× faster than the alternatives).
- Found while measuring: from the host, Docker Desktop's port forwarder adds ~44 ms to every message of 16 KB or
  more. New `npm run bench:docker` runs database benchmarks inside the Docker network.

### Docs
- `docs/performance.md`: every comparison with its table, query plans and trade-offs.
- `docs/roadmap.md`: skills that would fit next to these (a Postgres job queue, zero-downtime migrations, LLM
  tool safety, and more), with the proof each would need. Its first entry, `idempotency-keys`, ships in this release.
- README: the new production bugs and a "measured against the alternatives" table.

## 0.2.0 — 2026-10-21

### Fixed — latent bugs in the reference code
Each bug was reproduced by a failing test first (`verify/tests/latent-bugs.test.ts`), then fixed.
- `pii-redaction`: the email pattern's unbounded local part made redaction O(n²) on long strings. A 50 KB log
  line without `@` took ~1.9 s, a denial-of-service through the logging path. Quantifiers are now bounded,
  detectors have cheap pre-checks, and strings over 16 KiB are truncated before scanning.
- `llm-gateway`: a model missing from the price table was costed at $0, so budgets silently never limited
  anything. The gateway now refuses to start with budgets enabled and an unpriced model.
- `llm-gateway`: a call that crossed a month boundary settled in the new month and left its reservation stuck in
  the old one. The period is now captured once per call.
- `rate-limiting`: the local fallback evicted in insertion order, so the busiest subject was evicted first and
  came back with a full bucket. Eviction is now true LRU.
- `multitenant-postgres`: `SET LOCAL hnsw.iterative_scan` aborts the transaction on pgvector 0.5–0.7 once the
  library is loaded (a reserved prefix), which bites on reused pooled connections. It is now only set when
  supported.
- One suspected bug was a false positive: the readiness-check timeout in `service-hardening` does not leak an
  unhandled rejection, because `Promise.race` subscribes to it.

### Performance (`bench/run.ts`, numbers in docs/performance.md)
- Redacting a 50 KB log string: 1,891 ms → 0.22 ms. Structured log records: +71% throughput.
- `webhook-ingestion`: new `concurrency` option; 200 events with 5 ms handlers drain in 454 ms instead of
  3.2 s, still exactly once.
- `rate-limiting`: `EVALSHA` with a `NOSCRIPT` fallback instead of resending the script on every check. There
  is no measurable difference on localhost; it saves bytes per request on real networks.

### CI/CD
- CI: a new `validate-skills` job (frontmatter rules enforced on skill upload, broken links, eval sets kept
  outside `skills/`) and an informational benchmark run.
- CD: pushing a `v*` tag runs validation and all tests, packages every skill as a `.skill` file plus a kit
  zip, and publishes a GitHub release with notes taken from this changelog.

### Docs
- The README is rewritten around measured effect: what the agent shipped with and without each skill, and the
  production bugs the kit prevents.

## 0.1.0 — 2026-10-21

First public version.

### Skills
- 11 skills: `agent-safe-db`, `pii-redaction`, `multitenant-postgres`, `webhook-ingestion`, `outbox-pattern`,
  `rate-limiting`, `service-hardening`, `llm-gateway`, `llm-observability`, `sse-streaming`, `adr-writer`.
- Each skill has decision points to ask about, implementation steps, required verification and common mistakes,
  with reference code in `references/`.

### Verification
- 108 tests in `verify/tests` against real Postgres 17 + pgvector and Redis 7 (Docker), run in CI.
- Bugs caught while writing them and fixed in the reference code: an unhandled rejection that crashed Node when
  a Redis call lost a `Promise.race` timeout (`rate-limiting`); superusers silently bypassing RLS even with
  `FORCE` (`multitenant-postgres` now warns and tests it).

### Evaluation (skill-creator, 3 iterations)
- `agent-safe-db`, `webhook-ingestion` and `llm-gateway` evaluated with and without the skill on 6 prompts;
  see [docs/evaluation.md](docs/evaluation.md).
- Changes driven by the evaluation:
  - `llm-gateway`: atomic reserve-then-settle budgets (concurrent requests can't overshoot), semantic cache in
    shadow mode by default, usage-sink failures never fail a request.
  - `agent-safe-db`: write tests must turn `read_only` off and assert `42501`; tenant scoping and PII masking in
    the database; `CREATE`/`TEMP` revoked for raw-SQL roles; guest-chat decision point.
  - `webhook-ingestion`: sign test payloads with the provider's own tooling; assert "processed once" through the
    worker; read-only return URLs; inline validation reads for VNPay `RspCode`.
  - Eval sets moved from `skills/*/evals/` to `evals/` after a with-skill run read its own rubric.
