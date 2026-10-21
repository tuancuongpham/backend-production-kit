<div align="center">

**English** · [Tiếng Việt](docs/readme/README.vi.md)

# backend-production-kit

### Production backend skills for AI coding agents.

**Teach your agent the decisions, not just the code — and make it prove the result with tests.**

[![CI](https://img.shields.io/github/actions/workflow/status/tuancuongpham/backend-production-kit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tuancuongpham/backend-production-kit/actions/workflows/ci.yml)
[![Skills](https://img.shields.io/badge/skills-11-2f81f7?style=flat-square)](#the-skills)
[![Verification tests](https://img.shields.io/badge/tests-108%20passing-2ea043?style=flat-square)](#verification)
[![Node 24](https://img.shields.io/badge/node-%E2%89%A524-339933?style=flat-square&logo=node.js&logoColor=white)](#verification)
[![Postgres + Redis](https://img.shields.io/badge/Postgres%2017%20%2B%20pgvector%20%7C%20Redis%207-tested-336791?style=flat-square)](#verification)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

</div>

AI agents write backend code quickly, but they don't know *your* trade-offs: should the rate limiter fail open or
closed when Redis dies? May the chatbot's database role ever write? What happens when a webhook arrives twice?
Each skill in this kit encodes those decisions, the steps to implement them, and the tests that prove the
result — so the agent asks the right questions, builds the boring-but-critical parts correctly, and shows you
evidence instead of a claim.

## Quick start

### Install the skills

Copy them into Claude Code's skills folder (all projects), or into `<project>/.claude/skills/` (one project):

```powershell
Copy-Item -Recurse .\skills\* "$env:USERPROFILE\.claude\skills\"
```

```bash
cp -r skills/* ~/.claude/skills/
```

Or install the kit as a plugin from an interactive `claude` terminal:

```text
/plugin marketplace add tuancuongpham/backend-production-kit
/plugin install backend-production-kit@backend-production-kit
```

### Use them

You don't need to name a skill — describe the task and the matching skill loads:

| Ask your agent | Skill it uses | What you get |
|---|---|---|
| "Let our support bot look up orders in Postgres" | `agent-safe-db` | read-only role on masked views, typed tools, timeouts, audit, tests proving writes are denied |
| "Add a VNPay IPN / Stripe webhook endpoint" | `webhook-ingestion` | signature check, idempotent inbox, retries, dead letters, replay, reconciliation |
| "Our OpenAI bill tripled — cap cost per customer" | `llm-gateway` | atomic per-tenant budgets, caching, fallback, cost ledger and spike alerts |
| "Customer A can see customer B's documents" | `multitenant-postgres` | RLS with `FORCE`, composite FKs, tenant-safe hybrid search, CI audit |
| "Deploys cause 502s" | `service-hardening` | timeouts, load shedding, probes, graceful shutdown |

## The skills

| Skill | What it covers | Tests |
|---|---|---|
| [`agent-safe-db`](skills/agent-safe-db/SKILL.md) | Database access for AI agents that cannot write, cross tenants or read raw PII | 13 |
| [`pii-redaction`](skills/pii-redaction/SKILL.md) | Strip emails, phones, national IDs, cards and tokens from logs, traces and error reports | 21 |
| [`multitenant-postgres`](skills/multitenant-postgres/SKILL.md) | Row-Level Security done right, plus pgvector + full-text hybrid search with RRF | 10 |
| [`webhook-ingestion`](skills/webhook-ingestion/SKILL.md) | Verify → store once → process async → retry → dead-letter → replay → reconcile | 11 |
| [`outbox-pattern`](skills/outbox-pattern/SKILL.md) | Transactional outbox + ordered relay + deduplicating consumers ("effectively once") | 6 |
| [`rate-limiting`](skills/rate-limiting/SKILL.md) | Redis token bucket with explicit fail-open / fail-closed / local behaviour and a circuit breaker | 9 |
| [`service-hardening`](skills/service-hardening/SKILL.md) | Timeouts, backpressure, liveness vs readiness, graceful shutdown (Node, with Go notes) | 7 |
| [`llm-gateway`](skills/llm-gateway/SKILL.md) | Reserve-then-settle budgets, exact + shadow-mode semantic cache, fallback, FinOps ledger | 19 |
| [`llm-observability`](skills/llm-observability/SKILL.md) | OpenTelemetry spans that reconstruct exactly what the model saw, across queues | 4 |
| [`sse-streaming`](skills/sse-streaming/SKILL.md) | Token and live-feed streaming with replay, heartbeats, backpressure and cancellation | 6 |
| [`adr-writer`](skills/adr-writer/SKILL.md) | Architecture Decision Records, benchmark reports and public write-ups | 2 |

Every `SKILL.md` follows the same shape:

1. **Decision points** — the questions the agent must ask you first, each with a default and the reason.
2. **Implementation steps** — pointing at reference code in `references/`.
3. **Verification** — properties that must be proven by tests, not asserted in prose.
4. **Record the decision** — what goes into an ADR.
5. **Common mistakes** — the failure modes the skill exists to prevent.

## Verification

Every claim a skill makes about its reference code is proven by a test against real infrastructure:

```bash
npm install
npm run verify:up      # Postgres 17 + pgvector on :55439, Redis 7 on :63799 (Docker)
npm test               # 108 tests
npm run verify:down
```

`npm run test:unit` runs the 56 tests that need no Docker. CI runs everything on every push.

Writing the tests caught real bugs, which are now fixed and guarded:

- **`rate-limiting`** — when a Redis call lost a `Promise.race` timeout, its later rejection went unhandled and
  **crashed the Node process**. A test that blocks Redis with a busy script fails without the fix.
- **`multitenant-postgres`** — superusers **bypass RLS even with `FORCE`**. Apps that connect as the Docker
  default user get no tenant isolation at all; the skill warns about it and tests it.

## Evaluation

Three skills were evaluated with [skill-creator](https://github.com/anthropics/skills): the same 6 prompts run
by an agent with and without the skill, graded against written assertions by independent grader agents.

| Iteration | What changed | With skill | Without skill |
|---|---|---|---|
| 1 | first run (assertions v1) | 100% | 81% |
| 2 | skills fixed from grader feedback, assertions tightened (v2) | 93% | 66% |
| 3 | evals 2, 4, 5 rerun with the fixed skills | **100%** | **66%** |

The fixes made in iteration 2 showed up where they were aimed in iteration 3: atomic budget reservation
(`llm-gateway`), webhook tests signed with Stripe's own tooling (`webhook-ingestion`), and `TEMP` revoked for
raw-SQL roles (`agent-safe-db`). Read [docs/evaluation.md](docs/evaluation.md) for the method and its limits —
one run per configuration, rubric written by the skill author, and no generated tests executed against a database.

## Project layout

```
.claude-plugin/          plugin.json + marketplace.json (install as a Claude Code plugin)
skills/<name>/
  SKILL.md               what the agent reads
  references/            reference code and SQL (adr-writer: assets/ + scripts/)
verify/
  docker-compose.yml     throwaway Postgres + pgvector and Redis
  tests/*.test.ts        verification tests (node:test)
evals/<name>/evals.json  evaluation prompts + assertions — kept outside skills/ so agents can't read the rubric
docs/                    README translation, evaluation results
```

## Contributing

Bug reports, new patterns and sharper tests are welcome — see [CONTRIBUTING.md](.github/CONTRIBUTING.md).
Security issues: please follow [SECURITY.md](.github/SECURITY.md).

## License

[MIT](LICENSE)
