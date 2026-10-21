// Postgres implementations of the gateway's CacheStore / BudgetStore / usage sink.
import type pg from 'pg';
import type { BudgetStore, CacheStore, CachedResponse, UsageRecord } from './gateway.ts';

const vec = (v: number[]) => `[${v.join(',')}]`;

export function pgCache(pool: pg.Pool): CacheStore {
  return {
    async getExact(key) {
      const { rows } = await pool.query(`SELECT value FROM llm_exact_cache WHERE key = $1 AND expires_at > now()`, [key]);
      return (rows[0]?.value as CachedResponse) ?? null;
    },
    async setExact(key, value, ttlSec) {
      await pool.query(
        `INSERT INTO llm_exact_cache (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(value), ttlSec],
      );
    },
    async findSimilar(scope, embedding, minSimilarity) {
      // Nearest neighbour within the scope; similarity threshold applied on the result.
      const { rows } = await pool.query(
        `SELECT value, 1 - (embedding <=> $2::vector) AS similarity
         FROM llm_semantic_cache
         WHERE scope = $1 AND expires_at > now()
         ORDER BY embedding <=> $2::vector
         LIMIT 1`,
        [scope, vec(embedding)],
      );
      const r = rows[0];
      return r && r.similarity >= minSimilarity ? { value: r.value as CachedResponse, similarity: Number(r.similarity) } : null;
    },
    async saveSimilar(scope, embedding, value, ttlSec) {
      await pool.query(
        `INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at)
         VALUES ($1, $2::vector, $3, now() + make_interval(secs => $4))`,
        [scope, vec(embedding), JSON.stringify(value), ttlSec],
      );
    },
  };
}

/** Reserve-then-settle on llm_budget: the conditional UPDATE is atomic across app instances. */
export function pgBudget(pool: pg.Pool): BudgetStore {
  return {
    async reserve(tenantId, period, usd, limitUsd) {
      await pool.query(`INSERT INTO llm_budget (tenant_id, period) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tenantId, period]);
      const res = await pool.query(
        `UPDATE llm_budget SET reserved_usd = reserved_usd + $3
         WHERE tenant_id = $1 AND period = $2 AND spent_usd + reserved_usd + $3 <= $4`,
        [tenantId, period, usd, limitUsd],
      );
      return res.rowCount === 1;
    },
    async settle(tenantId, period, reservedUsd, actualUsd) {
      await pool.query(
        `UPDATE llm_budget
           SET reserved_usd = GREATEST(0, reserved_usd - $3), spent_usd = spent_usd + $4
         WHERE tenant_id = $1 AND period = $2`,
        [tenantId, period, reservedUsd, actualUsd],
      );
    },
  };
}

export function pgUsageSink(pool: pg.Pool, traceId?: () => string | undefined) {
  return (u: UsageRecord) =>
    pool
      .query(
        `INSERT INTO llm_usage (tenant_id, user_id, feature, trace_id, provider, model, cache,
           input_tokens, output_tokens, cost_usd, latency_ms, fallback_from, ok, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [u.tenantId, u.userId ?? null, u.feature ?? null, traceId?.() ?? null, u.provider, u.model, u.cache,
          u.inputTokens, u.outputTokens, u.costUsd, Math.round(u.latencyMs), u.fallbackFrom, u.ok, u.error ?? null],
      )
      .catch((e) => console.error('llm usage write failed', e)); // never fail the user request on accounting
}
