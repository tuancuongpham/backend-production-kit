# Changelog

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
