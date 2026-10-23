// Postgres implementations of the gateway's CacheStore / BudgetStore / usage sink.
import type pg from 'pg';
import type { BudgetStore, CacheStore, CachedResponse, UsageRecord } from './gateway.ts';
import { withTransaction } from './pg-transaction.ts';
import { pgJson, pgText } from './pg-values.ts';

/**
 * Embedding as a binary query parameter. node-postgres sends Buffers in binary format and pgvector reads
 * them with vector_recv (int16 dims, int16 unused, float32 big-endian values): 6 KB for 1536 dims instead
 * of ~32 KB of text, no float parsing on the server, and the same float32 values pgvector stores anyway.
 * Measured: lookups and inserts about 3× faster (docs/performance.md). The parameter must be typed as
 * vector, e.g. `$2::vector` or a vector column in VALUES.
 */
export function vectorParam(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(4 + 4 * v.length);
  buf.writeInt16BE(v.length, 0);
  buf.writeInt16BE(0, 2);
  for (let i = 0; i < v.length; i++) buf.writeFloatBE(v[i], 4 + 4 * i);
  return buf;
}

export interface PgCacheOptions {
  /**
   * How findSimilar searches one scope (tenant + model route + system prompt).
   * - 'exact' (default): distance to every live entry of the scope, found through the (scope, expires_at)
   *   index. Always returns the true nearest entry; cost grows with entries per scope (measured p50:
   *   0.3 ms at 120 entries, 1.5 ms at 1,000, 9 ms at 5,000).
   * - 'ann': HNSW index + pgvector >= 0.8 iterative scan, for scopes past a few thousand entries (2.3 ms
   *   at 5,000). Needs the HNSW index (commented out in semantic-cache.sql), which makes every save ~7× slower.
   * A plain HNSW query with `WHERE scope = …` is the trap in between: the index returns its ef_search
   * (40) nearest rows across *all* scopes and the filter runs afterwards. Popular questions cached by
   * many tenants fill those 40 slots, and this tenant's own entry is never seen. Numbers in
   * docs/performance.md.
   */
  semanticSearch?: 'exact' | 'ann';
}

export function pgCache(pool: pg.Pool, opts: PgCacheOptions = {}): CacheStore {
  const strategy = opts.semanticSearch ?? 'exact';
  return {
    async getExact(key) {
      const { rows } = await pool.query(`SELECT value FROM llm_exact_cache WHERE key = $1 AND expires_at > now()`, [key]);
      return (rows[0]?.value as CachedResponse) ?? null;
    },
    async setExact(key, value, ttlSec) {
      await pool.query(
        `INSERT INTO llm_exact_cache (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, pgJson(value), ttlSec], // model output can contain NUL, which jsonb rejects
      );
    },
    async findSimilar(scope, embedding, minSimilarity) {
      const probe = vectorParam(embedding);
      let r: { value: unknown; similarity: number } | undefined;
      if (strategy === 'exact') {
        // ORDER BY the computed similarity (not the bare `<=>` operator) so the planner can't pick the
        // HNSW index and post-filter; it scans this scope's live rows through (scope, expires_at).
        const { rows } = await pool.query(
          `SELECT value, 1 - (embedding <=> $2::vector) AS similarity
           FROM llm_semantic_cache
           WHERE scope = $1 AND expires_at > now()
           ORDER BY similarity DESC
           LIMIT 1`,
          [scope, probe],
        );
        r = rows[0];
      } else {
        r = await withTransaction(pool, async (tx) => {
          // Keep walking the HNSW graph until a row of this scope turns up (pgvector >= 0.8). SET LOCAL needs the
          // transaction; the vector cast loads the library first, so pg_settings knows the parameter.
          await tx.query(
            `SELECT '[0]'::vector;
             SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)
             WHERE EXISTS (SELECT 1 FROM pg_settings WHERE name = 'hnsw.iterative_scan')`,
          );
          const { rows } = await tx.query(
            `SELECT value, 1 - (embedding <=> $2::vector) AS similarity
             FROM llm_semantic_cache
             WHERE scope = $1 AND expires_at > now()
             ORDER BY embedding <=> $2::vector
             LIMIT 1`,
            [scope, probe],
          );
          return rows[0];
        });
      }
      return r && r.similarity >= minSimilarity ? { value: r.value as CachedResponse, similarity: Number(r.similarity) } : null;
    },
    async saveSimilar(scope, embedding, value, ttlSec) {
      await pool.query(
        `INSERT INTO llm_semantic_cache (scope, embedding, value, expires_at)
         VALUES ($1, $2::vector, $3, now() + make_interval(secs => $4))`,
        [scope, vectorParam(embedding), pgJson(value), ttlSec],
      );
    },
  };
}

/** Reserve-then-settle on llm_budget: the conditional upsert is atomic across app instances. */
export function pgBudget(pool: pg.Pool): BudgetStore {
  return {
    async reserve(tenantId, period, usd, limitUsd) {
      // One statement (this runs before every paid call): creates the period row on first use and reserves
      // only while spent + reserved stays within the limit. ON CONFLICT takes the row lock, so concurrent
      // reservations queue on it and never overshoot. About 20% lower latency and a third more throughput
      // than an INSERT … DO NOTHING followed by a conditional UPDATE (docs/performance.md).
      const res = await pool.query(
        `INSERT INTO llm_budget AS b (tenant_id, period, reserved_usd)
         SELECT $1, $2, $3::numeric WHERE $3::numeric <= $4::numeric
         ON CONFLICT (tenant_id, period) DO UPDATE SET reserved_usd = b.reserved_usd + EXCLUDED.reserved_usd
         WHERE b.spent_usd + b.reserved_usd + EXCLUDED.reserved_usd <= $4::numeric
         RETURNING 1`,
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

/** Delete expired cache rows in batches. Run it on a schedule: nothing reads them again, and without
 *  this both cache tables grow forever. */
export async function pruneLlmCache(pool: pg.Pool, batchSize = 5000) {
  // A batch of 0 deletes nothing, and "fewer than batchSize" never holds: the loop would never end.
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError(`pruneLlmCache: batchSize must be a positive integer, got ${batchSize}`);
  const prune = async (sql: string) => {
    let total = 0;
    for (;;) {
      const n = (await pool.query(sql, [batchSize])).rowCount ?? 0;
      total += n;
      if (n < batchSize) return total;
    }
  };
  return {
    exact: await prune(`DELETE FROM llm_exact_cache WHERE key IN (SELECT key FROM llm_exact_cache WHERE expires_at <= now() LIMIT $1)`),
    semantic: await prune(`DELETE FROM llm_semantic_cache WHERE id IN (SELECT id FROM llm_semantic_cache WHERE expires_at <= now() LIMIT $1)`),
  };
}

/**
 * The gateway's `onUsage`. A failed write rejects, and the gateway hands it to onUsageError (or onError): it never
 * reaches the user's request, and it isn't hidden in console output either. Alert on it: a missing row is spend
 * the FinOps reports don't see.
 */
export function pgUsageSink(pool: pg.Pool, traceId?: () => string | undefined) {
  return async (u: UsageRecord): Promise<void> => {
    await pool.query(
      `INSERT INTO llm_usage (tenant_id, user_id, feature, trace_id, provider, model, cache,
         input_tokens, output_tokens, cost_usd, latency_ms, fallback_from, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [u.tenantId, u.userId ?? null, u.feature ?? null, traceId?.() ?? null, u.provider, u.model, u.cache,
        u.inputTokens, u.outputTokens, u.costUsd, Math.round(u.latencyMs), u.fallbackFrom, u.ok, pgText(u.error ?? null)],
    );
  };
}
