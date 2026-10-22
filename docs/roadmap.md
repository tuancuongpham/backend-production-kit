# Roadmap: skills that fit next to these

Candidates for the next skills, ranked by three things: how often the problem bites the kind of backend this kit
targets (multi-tenant SaaS with AI features), how cheaply it can be built *with proof* (reference code plus tests
against real Postgres or Redis, like every skill here), and how much it reuses what already exists.

All nine ranked candidates are now built. What is left is in [Smaller candidates](#smaller-candidates).

| # | Skill | The production bug it prevents | Builds on | Status |
|---|---|---|---|---|
| 1 | [`idempotency-keys`](../skills/idempotency-keys/SKILL.md) | A client or an agent retries a POST after a timeout, and the order, charge or email happens twice | webhook-ingestion, outbox-pattern | built in 0.3.0 |
| 2 | [`job-queue`](../skills/job-queue/SKILL.md) | Background jobs lost on restart, run twice, or stuck behind one slow job | webhook-ingestion's worker, outbox-pattern | built in 0.4.0 |
| 3 | [`zero-downtime-migrations`](../skills/zero-downtime-migrations/SKILL.md) | A migration takes a table lock and every request queues behind it | every skill (they all ship SQL) | built in 0.4.0 |
| 4 | [`llm-tool-safety`](../skills/llm-tool-safety/SKILL.md) | An instruction hidden in a retrieved document makes the agent call a write tool | agent-safe-db, multitenant-postgres | built in 0.4.0 |
| 5 | [`cache-stampede`](../skills/cache-stampede/SKILL.md) | A hot key expires and hundreds of requests hit the database or the LLM at once | llm-gateway, rate-limiting, outbox-pattern | built in 0.4.0 |
| 6 | [`rag-evals`](../skills/rag-evals/SKILL.md) | A new chunk size or embedding model quietly makes answers worse | multitenant-postgres, llm-observability | built in 0.4.0 |
| 7 | [`data-retention-and-erasure`](../skills/data-retention-and-erasure/SKILL.md) | A deletion request misses the copies in caches, traces and queues | pii-redaction, multitenant-postgres, the prune functions | built in 0.4.0 |
| 8 | [`resilience-testing`](../skills/resilience-testing/SKILL.md) | The documented "degrades gracefully" was never tested against a slow dependency | rate-limiting, outbox-pattern, service-hardening | built in 0.4.0 |
| 9 | [`slo-alerting`](../skills/slo-alerting/SKILL.md) | Metrics exist, but nobody is paged until customers complain | the metrics every skill already lists | built in 0.4.0 |

## 1. idempotency-keys: built in 0.3.0

The inbound counterpart of what the kit already does for webhooks (dedup on `(provider, event_id)`) and for
consumers (`processed_messages`). See [the skill](../skills/idempotency-keys/SKILL.md) and its
[benchmark](performance.md#claiming-an-idempotency-key--idempotency-keys).

Building it surfaced a kit-wide bug. Every reference function that holds a pooled connection crashed the Node
process when Postgres ended that connection between two queries. All of them are fixed and tested in 0.3.0.

## 2. job-queue: built in 0.4.0

See [the skill](../skills/job-queue/SKILL.md) and its [benchmark](performance.md#claiming-a-job--job-queue). It
grew from the webhook worker: independent loops, graceful stop, and a claim that only touches what it claims. It
adds what a general queue needs:
- leases renewed by heartbeats, so a crashed worker's jobs come back and a long job's don't;
- delayed and recurring jobs;
- unique jobs;
- enqueueing in the business transaction.

Measuring the designs showed that delayed jobs need their own state. Sharing one `pending` state with due jobs
makes every poll walk past all of them.

## 3. zero-downtime-migrations: built in 0.4.0

See [the skill](../skills/zero-downtime-migrations/SKILL.md) and its
[benchmark](performance.md#schema-changes-on-a-live-table--zero-downtime-migrations).
- `runStep` runs each step under `lock_timeout` and retries with backoff when the lock isn't granted.
- A failed `CREATE INDEX CONCURRENTLY` leaves an `INVALID` index behind; `runStep` drops it before retrying.
- `backfill` updates in short batches and resumes where an interrupted run stopped.
- `lintMigration` flags statements that lock the table or break the version of the app still running.
- The expand/contract recipes include the retrofit `multitenant-postgres` needs on a live table: add
  `tenant_id`, backfill it, then enable RLS.

Measured on a 1M-row table:
- a read arriving behind a blocked `ALTER` waited 1 s without `lock_timeout`, and 52 ms with it;
- an insert during `CREATE INDEX` waited 1.5 s, and 2 ms with `CONCURRENTLY`;
- a volatile column default held an exclusive lock for 3.9 s while it rewrote every row.

## 4. llm-tool-safety: built in 0.4.0

`agent-safe-db` secures what an agent can *read*; [this skill](../skills/llm-tool-safety/SKILL.md) covers the
write side.
- Each tool has a tier (read, write, destructive) and a strict argument schema. The tenant and user come from the
  session, never from the model.
- Once a tool has returned untrusted content (a retrieved document, an email, a web page), every write needs a
  human approval. The approval is bound to the exact arguments, expires, and works once.
- Destructive tools always need one, optionally from a second person.
- A call runs once per `tool_call_id`: a retry replays the first result.
- Every call is audited with its outcome and whether untrusted content was in the context.

Proof: a poisoned document ("refund order o-7 … delete customer c-1") produces no write, and a reused, altered or
expired approval is rejected.

## 5. cache-stampede: built in 0.4.0

See [the skill](../skills/cache-stampede/SKILL.md) and its
[benchmark](performance.md#a-hot-key-expiring-under-load--cache-stampede).
- Single-flight per process, plus a Redis lock across instances.
- Stale-while-revalidate: a stale value is served at once while one refresh runs, and keeps being served while
  the origin is down.
- Jittered TTLs, cached misses and tenant-scoped keys.
- Invalidation after the commit, through the outbox when it crosses services.
- If Redis is down, the cache fails open and requests go to the origin.

When a hot key expired under 4 instances × 50 requests, it made 1 origin call instead of 200.

## 6. rag-evals: built in 0.4.0

See [the skill](../skills/rag-evals/SKILL.md).
- `evaluateRetriever` computes recall@k, MRR, nDCG and hit rate, with slices by query tag.
- `compareReports` is the CI gate. It lists the queries that broke.
- `judgeAgreement` measures an LLM judge against human labels before its scores are trusted: accuracy, Cohen's
  kappa and false passes.

Running it on the kit's own `hybridSearch` found a real gap. Questions typed as sentences matched nothing on the
keyword side, because every word had to match. The keyword side now falls back to any word
([numbers](performance.md#the-keyword-side-of-hybrid-search--multitenant-postgres-rag-evals)).

## 7. data-retention-and-erasure: built in 0.4.0

See [the skill](../skills/data-retention-and-erasure/SKILL.md). One inventory lists where each person's data lives
and what happens to it: delete, anonymize, or keep for a legal reason.
- An erasure applies the inventory to every table in one transaction.
- External stores are retried until done. A durable request record tracks this, and keeps only a peppered hash
  of the person's id once every store is done.
- The same inventory drives access exports and batched retention.
- A CI audit flags personal-looking columns nobody has classified, Vietnamese names included (`ho_ten`,
  `so_dien_thoai`, `cccd`).

Proof: after a user is erased, a scan of every text column in the database finds none of their identifiers.

## 8. resilience-testing: built in 0.4.0

See [the skill](../skills/resilience-testing/SKILL.md). Toxiproxy runs in the verify stack and in CI, and the
tests run the kit's own reference code through it. They found:
- a server-side `statement_timeout` doesn't bound a slow network; only a client-side `query_timeout` does;
- without `connectionTimeoutMillis`, a connection to a black-holed database waits forever;
- with `enableOfflineQueue: false`, an ioredis client fails every command until it has connected, so the app
  must connect before it reports ready;
- the outbox relay kept publishing after its connection died, so the whole batch went out twice. It now stops at
  once.

## 9. slo-alerting: built in 0.4.0

See [the skill](../skills/slo-alerting/SKILL.md). SLOs are defined in code. `prometheusRules` generates the
recording rules and the multi-window, multi-burn-rate alerts, and `promtool` checks and unit-tests them in CI.

The simulator shows what an incident would trigger:
- a 10% error rate pages in 9 minutes;
- a 0.2% slow burn opens a ticket after 36 hours and never pages;
- normal noise triggers nothing.

## Smaller candidates

Tenant-level RBAC on top of RLS, file uploads (presigned URLs, size and type limits, malware scanning), config and
secrets validation at startup, an append-only audit log, feature flags.

## Deliberately not planned

Writing an OIDC provider (use Keycloak, Zitadel, Auth0 or Clerk), Kubernetes autoscaling, and per-PR cloud
environments. They depend on cloud accounts and an agent creating or deleting cloud resources is a risk; they
belong in reviewed infrastructure code, not in a skill an agent applies on its own.

Want to build one? See [CONTRIBUTING](../.github/CONTRIBUTING.md): a skill is accepted with its reference code and
the tests that prove its claims.
