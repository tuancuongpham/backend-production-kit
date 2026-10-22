# Architecture of the reference code

The reference code in `skills/*/references/` is what an agent copies into someone else's codebase. It has to be
correct under failure, easy to adapt, and small enough to read in one sitting. These conventions keep the twenty
skills consistent; the invariants at the end are the bug classes three review rounds found, each turned into a
rule with a test.

## Two kinds of code, and one exception

**Stateful components are classes.** Anything with configuration, state and a lifecycle: workers, relays, the
gateway, limiters, caches, guards. Private state uses `#fields`. Dependencies come in through one options object,
validated in the constructor, so a bad configuration fails at startup rather than on the ten-thousandth request.

| Class | Skill | What it owns |
|---|---|---|
| `OutboxRelay` | outbox-pattern | publishing in commit order under one advisory lock |
| `InboxWorker` | webhook-ingestion | claiming, leasing and processing inbox rows |
| `JobWorker`, `Scheduler` | job-queue | leases and heartbeats for a batch; exactly-once schedule ticks |
| `IdempotencyKeys` | idempotency-keys | claims with tokens, stored responses, takeovers |
| `LlmGateway` | llm-gateway | caches, budget reservation, a breaker per provider |
| `ToolGuard`, `ToolSession` | llm-tool-safety | tiers, approvals, taint, run-once per tool-call id |
| `DataLifecycle` | data-retention-and-erasure | the inventory, erasure leases, retention |
| `AgentDb` | agent-safe-db | the agent role's pool and the trusted executor |
| `RateLimiter` | rate-limiting | the Redis bucket, the breaker, the local fallback |
| `ReadThroughCache` | cache-stampede | single-flight, locks, stale-while-revalidate, the codec |
| `SseStream`, `ReplayBuffer` | sse-streaming | one stream's backpressure; replayable event ids |
| `Toxiproxy`, `ToxicProxy` | resilience-testing | proxies and toxics |

`createX(options)` stays the entry point that the skills document, and returns the instance. The class is exported
for types and for code that wants to compose it.

**Pure logic stays functions.** That covers signature checks, fingerprints, backoff, retrieval metrics, Cohen's
kappa, the migration linter, the SLO rule generator and template filling. They have no state to encapsulate.
Wrapping them in classes would add ceremony and nothing to test.

**The exception: objects whose methods get passed around.** `createRedactor()` and `createHardenedServer()` return
plain objects of closures. Their functions are routinely handed over detached, as in `{ redact: redactor.redactString }`
or `installSignalHandlers(app.shutdown)`, and a detached class method loses `this`.

## Ports and adapters

The core of a skill depends on small interfaces at its edges, and infrastructure plugs in from outside. This is
where the code is open for extension: a new broker, model provider or store is a new adapter, with no change to
the core.

| Port | Skill | Adapters in the kit | Typical additions |
|---|---|---|---|
| `Publish` | outbox-pattern | a function | NATS JetStream, Kafka, SQS |
| `Provider` | llm-gateway | fakes in tests | Anthropic, OpenAI, AI SDK, LiteLLM |
| `CacheStore`, `BudgetStore` | llm-gateway | `memoryCache`, `memoryBudget`, `pgCache`, `pgBudget` | Redis |
| `TaintStore` | llm-tool-safety | `pgTaintStore` | Redis with a TTL |
| `ExternalStore` | data-retention-and-erasure | a Redis example in the tests | search index, object storage, vendor APIs |
| `Codec` | cache-stampede | `jsonCodec` | superjson, msgpack |
| `Retriever`, `Judge` | rag-evals | — | your search; your judge model |
| `Detector` | pii-redaction | `defaultDetectors` | your own identifiers |

## The shared kernel

Four building blocks recur across skills. Each skill ships as its own `.skill` file, so a skill can't import from
another skill's folder. The canonical copies live in [`shared/`](../shared) and are vendored into each skill that
imports them:

| File | Gives you | Used by |
|---|---|---|
| [`pg-transaction.ts`](../shared/pg-transaction.ts) | `withClient`, `withTransaction`: a connection that dies mid-call fails that call, not the process | 9 skills |
| [`with-timeout.ts`](../shared/with-timeout.ts) | a deadline for any promise, whose late rejection can't crash Node | outbox, limiter, cache, server |
| [`circuit-breaker.ts`](../shared/circuit-breaker.ts) | a breaker with a real half-open state: one probe, not the whole backlog | gateway, limiter, cache |
| [`worker-loop.ts`](../shared/worker-loop.ts) | `runLoops`: independent poll loops, idle pause, graceful stop | webhooks, jobs, outbox |

Edit the file in `shared/`, then run `npm run sync:shared`. `npm run validate` fails when a copy differs from
`shared/`, when an import has no copy, or when a copy is no longer imported.

## Invariants

Each of these was a bug in this kit, found by a failing test first. The fix is the rule.

1. **A claim carries a token, and only its holder may finish or release it.** Jobs (`lease_id`), webhook rows
   (`lease_id`, plus a row lock held for the whole handler), idempotency keys and tool calls (`claim_token`), and
   erasure requests (a lease) all follow it. Without it, a worker that was too slow overwrote the outcome of the one
   that took over, a slow webhook handler credited a payment twice, and a timed-out request freed a key that a
   retry was still using.
2. **A connection that dies mid-work fails the call, not the process.** Every checked-out client goes through
   `withClient`. A pool the code creates itself gets an `error` listener, a connect timeout and a client-side
   query timeout.
3. **Every wait has a deadline.** That means `withTimeout`, `AbortSignal.timeout`, `query_timeout` and
   `connectionTimeoutMillis`. A server-side `statement_timeout` limits the work, not a slow or black-holed network.
4. **A breaker lets one probe through after its cooldown.** Letting the whole backlog through makes each request
   wait out the full timeout of a dependency that is still down.
5. **Optional infrastructure fails open and never turns a success into a failure.** This covers caches,
   embeddings, usage sinks and tracing; their errors go to `onError`. Controls fail closed: budget reservations,
   approvals, Row-Level Security.
6. **Work that already happened is not redone because of an error after it.** When the model has answered and
   the cache write fails, the gateway returns the answer. It doesn't buy a second one from the fallback provider.
7. **Configuration is checked at construction.** This covers breaker thresholds, provider names and prices,
   inventory coverage (an anonymized row must lose every personal column) and regex flags (a non-global detector
   redacts only the first match).
8. **State that outlives a request lives outside process memory.** That includes the taint of an agent session
   (its next turn may hit another instance) and event ids that must survive a restart.
9. **Untrusted text is inserted with a replacer function, never a replacement string.** In
   `String.prototype.replace`, `$&` and `$'` are patterns: an answer or a title containing them was mangled.

## Testing seams

- Clocks (`now`), randomness (`random`) and stores are injected.
- No component keeps module-level mutable state.
- Every worker has a single-step method for tests (`processOnce`, `relayOnce`, `tick`) and a loop for production
  (`run({ signal })`).
- [`verify/tests/latent-bugs-round3.test.ts`](../verify/tests/latent-bugs-round3.test.ts) holds the 34 hypotheses
  of the last review as tests, every one of which failed on the code before its fix.

## What it deliberately doesn't do

- **No inheritance hierarchies.** Behaviour is shared by composition: the gateway *has* a breaker per provider,
  and the cache *has* one for Redis.
- **No dependency-injection container or framework.** One options object per component is the whole wiring, and
  it reads the same in any codebase the code is copied into.
- **No shared base class for the workers.** The three workers share `runLoops` and differ in everything else. A
  base class would couple three skills' semantics to save twenty lines.
- **No static utility classes.** A function is the unit for logic without state.
