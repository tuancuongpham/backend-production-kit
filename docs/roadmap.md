# Roadmap: skills that fit next to these

Candidates for the next skills, ranked by three things: how often the problem bites the kind of backend this kit
targets (multi-tenant SaaS with AI features), how cheaply it can be built *with proof* (reference code plus tests
against real Postgres or Redis, like every skill here), and how much it reuses what already exists.

| # | Skill | The production bug it prevents | Builds on | Effort |
|---|---|---|---|---|
| 1 | [`idempotency-keys`](../skills/idempotency-keys/SKILL.md) (**built in 0.3.0**) | A client or an agent retries a POST after a timeout, and the order, charge or email happens twice | webhook-ingestion, outbox-pattern | done |
| 2 | [`job-queue`](../skills/job-queue/SKILL.md) (**built**) | Background jobs lost on restart, run twice, or stuck behind one slow job | webhook-ingestion's worker, outbox-pattern | done |
| 3 | `zero-downtime-migrations` | A migration takes a table lock and every request queues behind it | every skill (they all ship SQL) | 2–3 days |
| 4 | `llm-tool-safety` | An instruction hidden in a retrieved document makes the agent call a write tool | agent-safe-db, llm-gateway, llm-observability | 2–3 days |
| 5 | `cache-stampede` | A hot key expires and hundreds of requests hit the database or the LLM at once | llm-gateway, rate-limiting, outbox-pattern | 1–2 days |
| 6 | `rag-evals` | A new chunk size or embedding model quietly makes answers worse | multitenant-postgres, llm-observability | 2–4 days |
| 7 | `data-retention-and-erasure` | A deletion request misses the copies in caches, traces and queues | pii-redaction, multitenant-postgres, the prune functions | 2 days |
| 8 | `resilience-testing` | The documented "degrades gracefully" was never tested against a slow dependency | rate-limiting, outbox-pattern, service-hardening | 1–2 days |
| 9 | `slo-alerting` | Metrics exist, but nobody is paged until customers complain | the metrics every skill already lists | 1–2 days |

## 1. idempotency-keys: built in 0.3.0

The inbound counterpart of what the kit already does for webhooks (dedup on `(provider, event_id)`) and for
consumers (`processed_messages`). See [the skill](../skills/idempotency-keys/SKILL.md) and its
[benchmark](performance.md#claiming-an-idempotency-key--idempotency-keys).

Building it surfaced a kit-wide bug. Every reference function that holds a pooled connection crashed the Node
process when Postgres ended that connection between two queries. All of them are fixed and tested in 0.3.0.

## 2. job-queue: built

See [the skill](../skills/job-queue/SKILL.md) and its [benchmark](performance.md#claiming-a-job--job-queue). It
grew from the webhook worker: independent loops, graceful stop, and a claim that only touches what it claims. It
adds what a general queue needs:
- leases renewed by heartbeats, so a crashed worker's jobs come back and a long job's don't;
- delayed and recurring jobs;
- unique jobs;
- enqueueing in the business transaction.

Measuring the designs showed that delayed jobs need their own state. Sharing one `pending` state with due jobs
makes every poll walk past all of them.

## 3. zero-downtime-migrations

Every skill here ships SQL, and agents write migrations all the time. The dangerous ones look harmless:
`CREATE INDEX` without `CONCURRENTLY`, adding a foreign key or `SET NOT NULL` on a big table, and any
`ACCESS EXCLUSIVE` lock that waits, because every later read queues behind the waiting lock. The skill covers
expand/contract releases, `lock_timeout` on every migration, batched backfills, and `NOT VALID` followed by
`VALIDATE`. It also covers the retrofit `multitenant-postgres` needs on an existing app: add `tenant_id`,
backfill it, then enable RLS.

Proof: CI runs each migration while a test transaction holds a lock on the table, with `lock_timeout = '2s'`.
The migration either finishes without blocking readers or fails fast. An old app version keeps working against
the expanded schema.

## 4. llm-tool-safety

`agent-safe-db` secures what an agent can *read*. This is the write side:
- tools grouped by permission tier;
- arguments validated against a schema before execution;
- every write tool takes an idempotency key (#1);
- destructive actions need a human approval bound to the exact arguments and usable once;
- content from retrieved documents, emails or web pages is treated as data and can never authorize a tool call.

Proof: an injected instruction inside a retrieved document cannot produce a write without an approval; a reused or
altered approval is rejected; every tool call shows up in the trace with tenant, user and approval id
(`llm-observability`); per-tenant spend on tool-driven LLM loops is capped (`llm-gateway`).

## 5. cache-stampede

A read-through cache that holds under load:
- single-flight per key, so 100 concurrent misses make 1 origin call;
- stale-while-revalidate, so a dead origin still serves recent data;
- jittered TTLs;
- tenant-scoped keys;
- invalidation published through the outbox after commit, never before.

The gateway's exact cache is a special case of it.

Proof: concurrent misses → one origin call; origin down → stale value served within the grace window; a write
invalidates only after commit; tenant A never reads tenant B's key.

## 6. rag-evals

`hybridSearch` already returns `semantic_rank` and `keyword_rank`, and `llm-gateway` already asks for a labelled
eval before the semantic cache serves anything. This skill provides the harness:
- a golden set per tenant type;
- recall@k and MRR for retrieval, computed in CI;
- an LLM judge whose agreement with human labels is measured before anyone trusts it;
- scores attached to traces.

Proof: a deliberately broken retriever (wrong RRF k, truncated chunks) fails the CI gate.

## 7. data-retention-and-erasure

Personal data ends up in more places than the main tables:
- webhook payloads;
- outbox messages;
- the LLM usage ledger;
- traces;
- the semantic cache: the embedding of a user's question is personal data too.

Retention policies, deletion requests (GDPR, Vietnam's Decree 13/2023) and tenant offboarding all need one
inventory and batched deletes. The building blocks exist already: `pruneInbox`, `pruneLlmCache`, `pruneOutbox`,
the redactor, and the RLS audit's list of tenant tables.

Proof: after erasing user X, no table, cache or trace store returns X's data; offboarding a tenant exports and
then deletes every row with its `tenant_id`; retention jobs run in bounded batches.

## 8. resilience-testing

The cheap version of a chaos toolkit: Toxiproxy in `docker-compose`, and tests that add latency or reset
connections to Postgres, Redis and the broker, then assert each skill's documented degradation:
- the limiter falls back within `timeoutMs`;
- the relay's publish timeout releases its lock (0.3.0 fixed exactly that bug);
- a Postgres failover mid-transaction fails one request, not the process (0.3.0 fixed that one too);
- the server answers 503 instead of hanging;
- the webhook worker backs off.

## 9. slo-alerting

Each skill already names its metrics: outbox lag, reconciliation `missed`, limiter `source`, TTFT, cache hit rate.
This skill turns them into SLOs with multi-window burn-rate alerts, so a fast burn pages someone and a slow burn
opens a ticket, and keeps the dashboards in code.

Proof: a synthetic error burst fires the fast-burn alert; a slow burn does not page.

## Smaller candidates

Tenant-level RBAC on top of RLS, file uploads (presigned URLs, size and type limits, malware scanning), config and
secrets validation at startup, an append-only audit log, feature flags.

## Deliberately not planned

Writing an OIDC provider (use Keycloak, Zitadel, Auth0 or Clerk), Kubernetes autoscaling, and per-PR cloud
environments. They depend on cloud accounts and an agent creating or deleting cloud resources is a risk; they
belong in reviewed infrastructure code, not in a skill an agent applies on its own.

Want to build one? See [CONTRIBUTING](../.github/CONTRIBUTING.md): a skill is accepted with its reference code and
the tests that prove its claims.
