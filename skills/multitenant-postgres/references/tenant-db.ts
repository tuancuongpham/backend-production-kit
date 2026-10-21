// Tenant-scoped data access on top of Postgres RLS.
// Every query for tenant data goes through withTenant(): the tenant id is set with
// set_config(..., is_local = true), so it lives only for this transaction and can't
// leak to the next request that reuses the pooled connection (safe with PgBouncer
// in transaction mode, too).
import type pg from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** tenantId must come from the authenticated session/JWT claim, never from the request body. */
export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('invalid tenant id');
  const client = await pool.connect();
  // If the server ends this connection between two queries (failover, idle_in_transaction_session_timeout),
  // pg emits 'error' on the client. Unheard while it is checked out, that crashes the whole process; heard,
  // only this request fails (its next query rejects) and the pool drops the dead client.
  let lost: Error | undefined;
  const onLost = (err: Error) => {
    lost = err;
  };
  client.on('error', onLost);
  try {
    // BEGIN and set_config in one round trip (a parameterized query can't share a call with BEGIN).
    // RLS itself costs ~nothing; the round trips around it are what a request pays: this cuts a
    // primary-key lookup from 4 round trips to 3, 19% faster on a fast network (docs/performance.md).
    // Inlining is safe ONLY because UUID_RE above lets nothing but hex digits and dashes through.
    // Never inline a value that hasn't passed a check this strict.
    await client.query(`BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.off('error', onLost);
    client.release(lost);
  }
}

export interface HybridSearchParams {
  embedding: number[];
  query: string;
  /** Final number of results. */
  limit?: number;
  /** Candidates taken from each retriever before fusion. */
  candidates?: number;
  /** RRF constant; 60 is the value from the original paper and a sane default. */
  rrfK?: number;
}

export interface HybridHit {
  id: string;
  document_id: string;
  content: string;
  rrf_score: number;
  semantic_rank: number | null;
  keyword_rank: number | null;
}

/**
 * Reciprocal Rank Fusion of pgvector cosine search and full-text search.
 * RLS restricts both retrievers to the current tenant automatically — no tenant
 * predicate here on purpose, so a missing one can't be "forgotten" per query.
 * Must run inside withTenant().
 */
export async function hybridSearch(client: pg.PoolClient, p: HybridSearchParams): Promise<HybridHit[]> {
  // pgvector >= 0.8: keep scanning the HNSW index until enough rows survive the RLS filter.
  // Without this, a small tenant in a big table can get far fewer than `candidates` hits.
  // Only set it where it exists. On pgvector 0.5–0.7 "hnsw." is a reserved prefix once the library is
  // loaded, so a plain SET LOCAL fails on every reused pooled connection and aborts the transaction.
  // The vector cast loads the library first, so pg_settings is accurate (one round trip, two statements).
  await client.query(
    `SELECT '[0]'::vector;
     SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)
     WHERE EXISTS (SELECT 1 FROM pg_settings WHERE name = 'hnsw.iterative_scan')`,
  );
  const { rows } = await client.query<HybridHit>(
    `WITH semantic AS (
       SELECT id, rank() OVER (ORDER BY dist) AS rank
       FROM (SELECT id, embedding <=> $1::vector AS dist
             FROM chunks
             ORDER BY embedding <=> $1::vector
             LIMIT $3) s
     ),
     keyword AS (
       SELECT id, rank() OVER (ORDER BY score DESC) AS rank
       FROM (SELECT c.id, ts_rank_cd(c.tsv, q) AS score
             FROM chunks c, websearch_to_tsquery('simple', kit_unaccent($2)) q
             WHERE c.tsv @@ q
             ORDER BY score DESC
             LIMIT $3) k
     )
     SELECT c.id, c.document_id, c.content,
            (COALESCE(1.0 / ($4 + s.rank), 0) + COALESCE(1.0 / ($4 + k.rank), 0))::float8 AS rrf_score,
            s.rank::int AS semantic_rank,
            k.rank::int AS keyword_rank
     FROM semantic s
     FULL OUTER JOIN keyword k USING (id)
     JOIN chunks c USING (id)
     ORDER BY rrf_score DESC
     LIMIT $5`,
    [vectorParam(p.embedding), p.query, p.candidates ?? 50, p.rrfK ?? 60, p.limit ?? 10],
  );
  return rows;
}

/**
 * Embedding as a binary parameter in pgvector's wire format (int16 dims, int16 unused, float32
 * big-endian values). node-postgres sends Buffers in binary, so 1536 dims travel as 6 KB instead of
 * ~32 KB of text and the server skips float parsing (a cheap vector lookup got about 3× faster from
 * this alone, docs/performance.md).
 */
function vectorParam(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(4 + 4 * v.length);
  buf.writeInt16BE(v.length, 0);
  buf.writeInt16BE(0, 2);
  for (let i = 0; i < v.length; i++) buf.writeFloatBE(v[i], 4 + 4 * i);
  return buf;
}
