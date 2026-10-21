# Changelog

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
