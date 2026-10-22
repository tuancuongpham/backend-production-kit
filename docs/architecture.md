# Architecture of the reference code

The reference code in `skills/*/references/` is what an agent copies into someone else's codebase. It has to be
correct under failure, easy to adapt, and small enough to read in one sitting. These conventions keep the twenty
skills consistent; the invariants at the end are the bug classes five review rounds found, each turned into a
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

Six building blocks recur across skills. Each skill ships as its own `.skill` file, so a skill can't import from
another skill's folder. The canonical copies live in [`shared/`](../shared) and are vendored into each skill that
imports them:

| File | Gives you | Used by |
|---|---|---|
| [`pg-transaction.ts`](../shared/pg-transaction.ts) | `withClient`, `withTransaction`: a connection that dies mid-call fails that call, not the process | 9 skills |
| [`pg-values.ts`](../shared/pg-values.ts) | `pgText`, `pgJson`: text from users, providers and models made storable (a NUL or half an emoji becomes U+FFFD, a BigInt a string) | 8 skills |
| [`hooks.ts`](../shared/hooks.ts) | `callHook`: an app's hook (onError, onDead, onOverflow…) that throws or rejects changes nothing | 9 skills |
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
10. **Text from outside is made storable where it is stored.** Postgres refuses a NUL in text and jsonb, and half
    of a surrogate pair in jsonb: one `%00` in a webhook made the provider retry it forever, and a tool result cut
    mid-emoji failed to store after the refund ran, so the retry refunded again. Every statement that stores
    outside text goes through `pgText` or `pgJson`.
11. **A value from outside is checked whole before the database sees it.** A pattern matches the whole value, a
    date must exist, an id must parse. Otherwise the database is the validator: the caller gets a 500 or a
    `22P02` instead of an error it can act on, and a pattern without anchors let `o-1'; DROP TABLE …` through as
    an order id. Where the caller can't fix it (a URL edited by hand, an id the model made up), the value is
    simply unknown.
12. **A hook the app passes in can't change the outcome of the work it watches.** `onError`, `onDead`,
    `onOverflow`, `onUsage`, `onBatch` go through `callHook`: whatever they throw, or the promise they return
    rejects with, is dropped. Called bare, an alert that failed turned a recorded dead letter into an exception, an
    async one rejecting while Slack was down ended the process, and a logger that threw stopped a worker loop.
    To stop work, pass a signal, not a hook that throws.

## Testing seams

- Clocks (`now`), randomness (`random`) and stores are injected.
- No component keeps module-level mutable state.
- Every worker has a single-step method for tests (`processOnce`, `relayOnce`, `tick`) and a loop for production
  (`run({ signal })`).
- The tests are organized by what they prove ([verify/README.md](../verify/README.md)), all against real Postgres,
  Redis and Toxiproxy:
  - `skills/<skill>.test.ts` prove what each skill's SKILL.md claims; `kernel/` the shared building blocks.
  - `regressions/round-N.test.ts` hold each review round's hypotheses. Every one failed on the code before its fix:
    34 in round 3, 25 in round 4, 21 in round 5.
  - `journeys/` drive several skills end to end over real HTTP, wired as an application wires them, through what
    users, providers and models do: retries, double taps, closed tabs, deploys, forged requests, edited URLs.
  - `properties/` check rules over generated input (fast-check): personal data in any format never survives
    redaction, and whatever a model sends is refused before the database would refuse it.
  - `invariants/` check a rule across every skill that could break it.
- Realistic input lives in [`fixtures/user-inputs.ts`](../verify/tests/fixtures/user-inputs.ts) and the generators
  in [`support/arbitraries.ts`](../verify/tests/support/arbitraries.ts). A new test reuses them rather than
  inventing "test" and "foo".
- Coverage is measured on every CI run and fails below 98% of lines, 90% of branches, 95% of functions. ESLint runs
  type-aware rules for bug classes: promises nobody awaits, returns that skip a `catch`, switches that miss a case.

## What it deliberately doesn't do

- **No inheritance hierarchies.** Behaviour is shared by composition: the gateway *has* a breaker per provider,
  and the cache *has* one for Redis.
- **No dependency-injection container or framework.** One options object per component is the whole wiring, and
  it reads the same in any codebase the code is copied into.
- **No shared base class for the workers.** The three workers share `runLoops` and differ in everything else. A
  base class would couple three skills' semantics to save twenty lines.
- **No static utility classes.** A function is the unit for logic without state.
