<div align="center">

**English** · [Tiếng Việt](docs/readme/README.vi.md)

# backend-production-kit

### Skills that make AI coding agents ship production-grade backends.

**Same agent, same prompt: with the kit it passes 100% of production checks; without it, 66%.**

[![CI](https://img.shields.io/github/actions/workflow/status/tuancuongpham/backend-production-kit/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tuancuongpham/backend-production-kit/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/tuancuongpham/backend-production-kit?style=flat-square&color=2f81f7)](https://github.com/tuancuongpham/backend-production-kit/releases/latest)
[![Node 24](https://img.shields.io/badge/node-%E2%89%A524-339933?style=flat-square&logo=node.js&logoColor=white)](#quick-start)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

</div>

AI agents write backend code that *runs*. What they miss are the parts that only fail in production: a chatbot role
that can read every customer's phone number, a webhook that credits twice, an LLM budget that concurrent requests walk
straight past. Each of the 20 skills gives the agent, for one of those areas, the decisions to ask you about, the
reference code and the tests that prove it holds. On six real tasks graded by independent reviewers against 57
production checks, the same agent scored 66% without the kit and 100% with it ([method](docs/evaluation.md)).

## The skills

Every number below comes from this repository's tests and benchmarks, run against real Postgres, Redis and Toxiproxy.

### Data and tenants

| Skill | Use it when you… | What it gets right, measured |
|---|---|---|
| [`agent-safe-db`](skills/agent-safe-db/SKILL.md) | give an agent or a chatbot access to your database | the agent's role reads masked views only, scoped to one tenant by Postgres itself; a write fails with *permission denied*; a tool call costs 0.51 ms |
| [`multitenant-postgres`](skills/multitenant-postgres/SKILL.md) | keep customers' data apart in one Postgres, vector search included | Row-Level Security tested as the app role (as a superuser it isolates nothing); the keyword side of hybrid search finds 10 of 10 typed questions, where requiring every word found none |
| [`pii-redaction`](skills/pii-redaction/SKILL.md) | log, trace or report errors that may hold personal data | phones, emails, cards, CCCD and secrets redacted in any format, checked over thousands of generated inputs; a 50 KB log line in 0.2 ms, not 1.9 s |
| [`data-retention-and-erasure`](skills/data-retention-and-erasure/SKILL.md) | handle deletion and export requests (GDPR, Decree 13/2023), and retention | after an erasure, a scan of every text column finds none of the person's identifiers; retention keeps what is still in its window, partitioned tables too |
| [`zero-downtime-migrations`](skills/zero-downtime-migrations/SKILL.md) | change a table the app is using: indexes, constraints, backfills | reads wait 52 ms behind a blocked `ALTER`, not 1 s; inserts wait 2 ms during an index build, not 1.5 s; a backfill runs to the end while the app writes |

### Payments and async work

| Skill | Use it when you… | What it gets right, measured |
|---|---|---|
| [`webhook-ingestion`](skills/webhook-ingestion/SKILL.md) | receive Stripe, VNPay, MoMo or GitHub webhooks | 10 concurrent duplicates make one payment; retries, dead letters, replay and reconciliation in code; a claim takes 0.6 ms with 200,000 events due, not 56 ms |
| [`idempotency-keys`](skills/idempotency-keys/SKILL.md) | accept retried POSTs or agent tool calls | 20 copies of one request run the handler once (check-then-insert ran it 20 times); a timed-out order is never committed by the next request |
| [`outbox-pattern`](skills/outbox-pattern/SKILL.md) | publish events after a database write | no event sent before its commit or lost after it; a hung broker can't stop delivery; 8× the relay throughput |
| [`job-queue`](skills/job-queue/SKILL.md) | send emails, run LLM work or schedule recurring jobs | leases with heartbeats, retries, dead letters, schedules fired once; an idle poll takes 0.3 ms next to 1M finished jobs, not 73 ms |

### Load and failure

| Skill | Use it when you… | What it gets right, measured |
|---|---|---|
| [`rate-limiting`](skills/rate-limiting/SKILL.md) | throttle APIs, logins or LLM endpoints | exactly 20 of 90 concurrent checks pass a limit of 20, across instances; with Redis slow or down, the policy you chose (open, closed or local) decides in under 300 ms |
| [`cache-stampede`](skills/cache-stampede/SKILL.md) | cache queries or LLM results in Redis | a hot key expiring under 200 requests makes 1 origin call, not 200; a stale entry is served in 0.7 ms while one caller refreshes it |
| [`service-hardening`](skills/service-hardening/SKILL.md) | ship an API to Docker or Kubernetes | deploys without 502s or 503s, long streams included; overload is shed in under 150 ms instead of a timeout for everyone |
| [`resilience-testing`](skills/resilience-testing/SKILL.md) | need to know what happens when Postgres or Redis is slow or down | Toxiproxy tests for each failure: with replies 1 s late, a client-side timeout fails the call in under 600 ms, where `statement_timeout` never fires |
| [`slo-alerting`](skills/slo-alerting/SKILL.md) | want alerts that page on real outages only | a 10% error rate pages in 9 minutes; a 0.2% leak opens a ticket and never pages; the rules pass Prometheus's `promtool` |

### AI features

| Skill | Use it when you… | What it gets right, measured |
|---|---|---|
| [`llm-gateway`](skills/llm-gateway/SKILL.md) | control LLM cost, cache answers or fall back between providers | per-tenant budgets reserved atomically, so concurrent requests can't overshoot; a dead provider gets 1 probe after its cooldown, not every waiting request |
| [`llm-tool-safety`](skills/llm-tool-safety/SKILL.md) | let an agent call tools that change data or move money | once untrusted text is in the context, every write waits for a human approval bound to its exact arguments; a retried call refunds once |
| [`llm-observability`](skills/llm-observability/SKILL.md) | need to explain why the model said what it said | one trace per request, HTTP → retrieval → LLM, with the prompt version, and the prompt and errors redacted |
| [`rag-evals`](skills/rag-evals/SKILL.md) | change chunking, embeddings or retrieval | a CI gate: dropping accent folding took recall@5 from 1.00 to 0.42, and the gate named the 7 queries that broke; 198 queries in 4.2 s |
| [`sse-streaming`](skills/sse-streaming/SKILL.md) | stream tokens or live updates to a browser | a closed tab stops the model call; a reconnect replays what was missed; a stalled tab is dropped instead of 40 MB buffered |

### Decisions

| Skill | Use it when you… | What it gets right |
|---|---|---|
| [`adr-writer`](skills/adr-writer/SKILL.md) | record a design decision or a benchmark | numbered ADRs with an index: the context, the decision, the alternatives and the numbers behind it |

Each `SKILL.md` lists the decisions to ask about, with defaults and reasons, the steps backed by reference code, the
properties its tests must prove, and the mistakes it exists to prevent.

## Quick start

Copy the skills into Claude Code's skills folder (all projects), or into `<project>/.claude/skills/`:

```bash
cp -r skills/* ~/.claude/skills/
```

```powershell
Copy-Item -Recurse .\skills\* "$env:USERPROFILE\.claude\skills\"
```

Or install the whole kit as a plugin from an interactive `claude` terminal:

```text
/plugin marketplace add tuancuongpham/backend-production-kit
/plugin install backend-production-kit@backend-production-kit
```

Every [release](https://github.com/tuancuongpham/backend-production-kit/releases/latest) also has each skill as a
`.skill` file to upload to claude.ai. Then describe the task ("add a Stripe webhook", "cap OpenAI cost per
customer"), and the matching skill loads on its own.

## Why the reference code can be trusted

- **Proven against real infrastructure.** 458 tests run on Postgres 17 with pgvector, Redis 7 and Toxiproxy, and
  cover 99.5% of the reference code's lines; CI fails below 98%. Nothing a claim depends on is mocked.
- **Reviewed for latent bugs, round after round.** Each round writes its suspicions down as tests that must fail on
  the code before the fix. Seven rounds so far; every bug and its test is in the [changelog](CHANGELOG.md).
- **Each hot path measured against its alternatives**, and the winner shipped: [docs/performance.md](docs/performance.md).
- **Sixteen invariants** every skill keeps, each one a bug this kit once had: [docs/architecture.md](docs/architecture.md).

```bash
npm install && npm run check   # skill rules, links, types, lint: no Docker needed
npm run verify:up && npm test  # every test against Postgres, Redis and Toxiproxy in Docker
```

## Contributing

New patterns and sharper checks are welcome: see [CONTRIBUTING.md](.github/CONTRIBUTING.md). Security issues:
please follow [SECURITY.md](.github/SECURITY.md).

## License

[MIT](LICENSE)
