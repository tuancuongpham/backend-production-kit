-- Postgres-backed LLM cache (exact + semantic) and usage ledger. Requires pgvector.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS llm_exact_cache (
  key        text PRIMARY KEY,               -- sha256(scope, messages, params)
  value      jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_exact_cache_expires_idx ON llm_exact_cache (expires_at); -- pruneLlmCache

CREATE TABLE IF NOT EXISTS llm_semantic_cache (
  id         bigserial PRIMARY KEY,
  scope      text NOT NULL,                  -- sha256(tenant, model route, system prompt)
  embedding  vector(1536) NOT NULL,          -- match the embedding model
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
-- pgvector stores vectors out of line (TOAST) by default, so exact search pays extra lookups for every row
-- it reads. Kept in the row instead, exact search ran 2–3× faster with identical results (docs/performance.md).
-- Fits up to ~2,000 dimensions; for 3072-dim models use halfvec(3072), which also halves the bytes read.
-- Applies to rows written from now on, so an existing cache converts itself within one TTL.
ALTER TABLE llm_semantic_cache ALTER COLUMN embedding SET STORAGE MAIN;
CREATE INDEX IF NOT EXISTS llm_semantic_cache_scope_idx ON llm_semantic_cache (scope, expires_at);   -- exact search
CREATE INDEX IF NOT EXISTS llm_semantic_cache_expires_idx ON llm_semantic_cache (expires_at);        -- pruneLlmCache
-- HNSW only for pgCache(pool, { semanticSearch: 'ann' }): scopes past a few thousand live entries, on
-- pgvector >= 0.8. Measured at 5,000 entries in one scope: 2.3 ms with HNSW + iterative scan vs 8.4 ms exact.
-- With the default exact search the index is never used, yet it makes every cache write ~7× slower
-- (9.2 ms instead of 1.2 ms), so don't create it "just in case". Building it on a full table in Docker
-- may run in parallel and need more than the default 64 MB /dev/shm: raise --shm-size.
-- CREATE INDEX IF NOT EXISTS llm_semantic_cache_vec_idx ON llm_semantic_cache USING hnsw (embedding vector_cosine_ops);

-- One row per LLM call (including cache hits and failures): the input for FinOps dashboards.
CREATE TABLE IF NOT EXISTS llm_usage (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  tenant_id     text NOT NULL,
  user_id       text,
  feature       text,                        -- 'support-chat', 'summarize-ticket', ...
  trace_id      text,                        -- join with traces
  provider      text,
  model         text,
  cache         text NOT NULL,               -- exact | semantic | miss | bypass
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms    int NOT NULL,
  fallback_from text[] NOT NULL DEFAULT '{}',
  ok            boolean NOT NULL,
  error         text
);
CREATE INDEX IF NOT EXISTS llm_usage_tenant_at_idx ON llm_usage (tenant_id, at);

-- Budget counters: the gateway reserves a pessimistic estimate here BEFORE calling the model
-- (one conditional upsert = atomic across app instances), then settles with the real cost.
CREATE TABLE IF NOT EXISTS llm_budget (
  tenant_id    text NOT NULL,
  period       text NOT NULL,                -- 'YYYY-MM' (UTC)
  spent_usd    numeric(12, 6) NOT NULL DEFAULT 0,
  reserved_usd numeric(12, 6) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);

-- Monthly spend per tenant from the ledger, for reports and for reconciling against llm_budget
-- (they can differ by in-flight reservations, or by usage rows that failed to write).
CREATE OR REPLACE VIEW llm_monthly_spend AS
  SELECT tenant_id, to_char(at, 'YYYY-MM') AS period, sum(cost_usd)::float8 AS usd
  FROM llm_usage GROUP BY 1, 2;

-- FinOps starter queries:
--   cost by tenant/feature/model this month
--   SELECT tenant_id, feature, model, sum(cost_usd) usd, count(*) calls,
--          avg((cache IN ('exact','semantic'))::int) cache_hit_rate
--   FROM llm_usage WHERE at >= date_trunc('month', now()) GROUP BY 1,2,3 ORDER BY usd DESC;
--   anomaly: today's spend vs trailing 7-day daily average per tenant
--   WITH d AS (SELECT tenant_id, date_trunc('day', at) day, sum(cost_usd) usd FROM llm_usage
--              WHERE at >= now() - interval '8 days' GROUP BY 1,2)
--   SELECT t.tenant_id, t.usd today, avg(h.usd) baseline FROM d t JOIN d h USING (tenant_id)
--   WHERE t.day = date_trunc('day', now()) AND h.day < t.day GROUP BY 1,2 HAVING t.usd > 3 * avg(h.usd);
