# Changelog

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
