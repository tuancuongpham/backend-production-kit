---
name: llm-gateway
description: Put a gateway layer in front of LLM API calls — per-tenant budgets, exact + semantic caching, timeouts, provider fallback with circuit breakers, and a per-call cost ledger for FinOps dashboards and spend alerts. Use whenever an app calls OpenAI/Anthropic/Gemini/etc. from more than one place, worries about LLM cost or 429/503/529 errors, wants "fallback to a cheaper model", "semantic cache", "token budget per customer", "chi phí LLM theo khách hàng", "dashboard chi phí AI", or is about to ship an AI feature to paying users.
---

# LLM gateway: cost, caching, availability

LLM APIs are the most expensive and least reliable dependency most apps have. The gateway is one choke point where you can **refuse** (budget), **reuse** (cache), **reroute** (fallback) and **record** (cost ledger) every call. Without it, those concerns get re-implemented per feature, or not at all.

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| **Build vs buy** | Buy the plumbing, build the policy | LiteLLM, Vercel AI Gateway, Portkey and OpenRouter already do routing, fallback, keys and basic budgets. Build only what they don't do for you: tenant-scoped semantic cache, business budgets, your cost ledger. The reference code works either way: an upstream gateway is just one `Provider`. |
| Fallback chain | Same-quality other vendor, then a cheaper model | A cheaper fallback changes answer quality. Product must accept that, and the response should say which model answered. |
| Semantic cache mode | **Shadow** (look up and log, never serve) until an eval proves it safe | Embeddings often score "refund my order" and "*don't* refund my order" > 0.9. Shadow mode collects the labelled pairs the eval needs. Switch a feature to `serve` only with a threshold tuned on that data. |
| Similarity threshold | 0.95, then tune | Measure the false-hit rate on a labelled sample (target < 1%) with the *real* embedding model. |
| Budget unit | USD per tenant per month | Tokens are confusing across models. Decide what happens at the limit: hard stop, degrade to a cheaper model, or alert only. Whatever you choose, the *default configuration* should actually cap spend; an "observe only" default protects nobody. |
| What to log per call | Usage row (no prompt text) | Prompts belong in traces with redaction (`llm-observability`), not in the billing table. |

## Implementation steps

1. **Core**: [references/gateway.ts](references/gateway.ts). `createGateway({ providers, prices, cache, embed, semanticMode, budget, onUsage })` → `chat(req, { tenantId, userId, feature, signal })`:
   - **Caches first**. A hit costs nothing, so it is served even to a tenant that's out of budget.
     - **Eligibility**: only `temperature 0`, no tools, not opted out.
     - **Scope** = tenant + model route + system prompt, so a cached answer never crosses tenants or personas.
   - **Exact cache** on `sha256(scope, messages, params)`. For "summarize X" features this also means *unchanged input is never re-summarized*. That is often the single biggest saving, and a frequent cause of a sudden 3× bill (re-summarizing on every view).
   - **Semantic cache**:
     - only for single-question requests, because in multi-turn chats the history changes the meaning;
     - `semanticMode` defaults to **`'shadow'`**: look up, report would-be hits through `onShadowHit` (question, cached question, similarity) for labelling, but still call the model. Switch to `'serve'` only after the eval below passes;
     - an optional extra guard is to reject hits whose negation words or numbers differ from the cached question. It is a heuristic, and it doesn't replace the eval.
   - **Budget, reserve then settle**: before calling a provider, atomically reserve a *pessimistic* cost estimate (`spent + reserved + estimate ≤ limit`, else `BudgetExceededError` with no provider call). Settle with the real cost afterwards; a failed call releases the reservation. A read-then-call check lets N concurrent requests all pass and overshoot by N × cost. Over-estimating is safe; under-estimating lets concurrency overshoot.
   - **Provider chain**: per-attempt timeout; fall back on 408/409/429/5xx/timeout. Don't fall back on 4xx (our bug, same everywhere). A circuit breaker per provider skips a failing vendor. Caller cancellation (`signal`) stops the chain.
   - **Cost** comes from a price table **in config**. Prices change; a missing price shows up as cost 0 and should alert.
   - **Accounting never fails a request**: `onUsage` errors, sync or async, are caught and passed to `onUsageError`.
2. **Stores**: [references/semantic-cache.sql](references/semantic-cache.sql) + [references/pg-stores.ts](references/pg-stores.ts):
   - Postgres/pgvector exact and semantic caches (Redis is a fine alternative for the exact cache);
   - the semantic lookup searches **only the caller's scope, exactly**, by default (`pgCache(pool)`). Measured p50 is 0.3 ms at 120 entries per scope, 1.5 ms at 1,000 and 9 ms at 5,000;
   - past a few thousand entries per scope, switch to `pgCache(pool, { semanticSearch: 'ann' })` with the HNSW index, on pgvector ≥ 0.8 (iterative scans): 2.3 ms at 5,000. The index makes every cache save ~7× slower, so don't create it before you need it;
   - **never a plain HNSW index plus `WHERE scope = …`**. The index hands back its 40 nearest rows across *all* tenants and the filter runs afterwards. A question that many tenants cached crowds out this tenant's own copy: 4 hits out of 20 in the benchmark, each miss a full-price model call;
   - embeddings travel as binary parameters (`vectorParam`): 6 KB instead of ~32 KB of text, and lookups and saves about 3× faster. The schema also keeps vectors inside the row (`SET STORAGE MAIN`), which makes exact search 2–3× faster;
   - the `llm_budget` counters: one conditional upsert per reservation, atomic across instances;
   - the `llm_usage` ledger for reports. Reconcile `llm_budget` against the `llm_monthly_spend` view daily, since they drift if a usage write is lost;
   - `pruneLlmCache(pool)` on a schedule. Expired rows are never read again, and without it both cache tables grow forever.
3. **Providers**: wrap each SDK call in the `Provider` interface and map its errors to `ProviderError(status)`. With an upstream gateway (LiteLLM / Vercel AI Gateway), the "provider" is that gateway, and you can lean on its fallback instead.
4. **Streaming**: stream tokens to the client (see `sse-streaming`). Write the cache entry and usage row when the stream completes, and replay cached answers as a stream so the UX is identical.
5. **FinOps dashboard and alerts** (project #14): the starter queries at the bottom of the SQL give cost by tenant/feature/model, cache hit rate, and a "today > 3× trailing average" anomaly check. Run the anomaly query on a schedule and page someone; that's how you catch a retry loop before the invoice does. Put `feature` on every call, since "which feature costs what" is the question you'll be asked.

## Verification (required)

[verify/tests/llm-gateway.test.ts](../../verify/tests/llm-gateway.test.ts) (fake providers, deterministic) and [llm-gateway-pg.test.ts](../../verify/tests/llm-gateway-pg.test.ts) (real Postgres):
- **Exact cache**: an identical request is an `exact` hit, the provider is called once, and cost 0 is recorded for the hit.
- **Semantic, serve mode**: a paraphrase hits; a negation and an unrelated question miss (controlled vectors; see the eval note below).
- **Semantic, default shadow mode**: a paraphrase is still a `miss`, the model is called, and `onShadowHit` receives both questions plus the similarity.
- **Scope**: no hits across tenants (exact *and* paraphrase) or across system prompts.
- **Bypass**: `temperature > 0`, tools or `cache:false` → `bypass`; multi-turn → no semantic match.
- **Fallback chain**:
  - 503 → fallback, with `fallbackFrom` reported and the cheaper price applied;
  - a hang → fallback within the timeout;
  - 400 → no fallback;
  - after N failures the breaker skips the primary;
  - all down → `AllProvidersFailedError`;
  - caller abort → no fallback.
- **Budget**:
  - it refuses without calling a provider; other tenants are unaffected;
  - **10 concurrent requests against room for 3 → exactly 3 reach the provider**, both in memory and with Postgres shared by two app instances;
  - a failed call releases its reservation;
  - cache hits are still served when out of budget.
- **Accounting**: a usage sink that throws or rejects doesn't fail the request.
- **Postgres stores**: TTL expiry, similarity threshold, scope isolation.
- **Many tenants, same question** ([latent-bugs-round2.test.ts](../../verify/tests/latent-bugs-round2.test.ts)): 100 tenants cache a popular question, and this tenant's own entry is still found with an HNSW index present. `pruneLlmCache` removes only expired rows.

When writing your own tests: make the concurrency test real (requests in flight together, e.g. a provider that sleeps), and inject a failing usage sink. Code inspection alone doesn't prove either property.

**Semantic-cache eval (needed before enabling it):** collect 200+ real query pairs from logs and label them same/different intent. Run them through the real embedding model, plot similarity by label, then pick the threshold and record the false-hit rate in the ADR. The unit test proves the plumbing, not the embedding model.

## Record the decision
ADR: build vs buy, fallback chain and its quality trade-off, semantic cache threshold with eval evidence, budget behaviour at the limit.

## Common mistakes
- A cache key without the tenant: one customer's answer is served to another.
- Caching `temperature > 0` or tool-calling responses: stale or wrong actions get replayed.
- Retrying 429s immediately across providers with no breaker: a vendor incident becomes your outage and your bill.
- Prices hardcoded next to business logic: wrong costs for months after a price change.
- Writing usage synchronously and failing the request when the ledger write fails.
- Checking the budget with a read (`SELECT sum(cost)`) and then calling: under load, every in-flight request passes the check.
- Turning the semantic cache on in `serve` mode on day one, with a threshold nobody measured.
- A model missing from the price table. Its estimate and cost are $0, so the budget silently never limits anything. The reference gateway refuses to start with budgets on and an unpriced model.
- Computing the budget period twice (once at reserve, once at settle). A call that crosses midnight at month end leaves its reservation stuck in the old month forever. Capture the period once per call.
- An HNSW index with a tenant filter on top (`ORDER BY embedding <=> $1 … WHERE scope = $2`). It looks like the textbook query and returns fast, but it misses the tenant's own entries exactly when a question is popular, so the cache fails where it would save the most.
- Sending embeddings as `'[0.0123,…]'` text: 32 KB per 1536-dim vector, parsed on every query. Send a binary parameter.
- Benchmarking a local Docker Postgres from the host on Docker Desktop: any message of 16 KB or more gets ~44 ms added by the port forwarder, so text-encoded vectors look 40 ms slow. Measure inside the Docker network (`npm run bench:docker`).
