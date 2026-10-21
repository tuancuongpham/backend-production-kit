---
name: multitenant-postgres
description: Design or retrofit tenant isolation in Postgres with Row-Level Security, plus hybrid search (pgvector semantic + full-text keyword, fused with RRF) that respects tenant boundaries. Use whenever the user builds a SaaS / B2B app with workspaces, organizations, shops or customers sharing one database, adds RAG or "search my documents" to such an app, mentions pgvector, tenant_id, RLS, "đa khách hàng", "multi-tenant", "cách ly dữ liệu", or asks why one customer could see another's data.
---

# Multi-tenant Postgres + hybrid search

Shared-schema multi-tenancy fails in one way: a query that forgets `WHERE tenant_id = …`. RLS moves that predicate into the database, so a forgotten filter returns *nothing* instead of *everyone's data*. Hybrid search then runs on top. Because both retrievers read through RLS, tenant isolation also holds for vector search, which is where hand-written filters most often get dropped.

## Decision points: ask before coding

| Decision | Default | When to choose otherwise |
|---|---|---|
| Isolation model | Shared tables + `tenant_id` + RLS | Schema- or database-per-tenant for strict contractual or data-residency isolation, or a few very large tenants. Costs: migrations × N, pooling. |
| How the tenant reaches the DB | `set_config('app.tenant_id', $1, true)` per transaction | Never a session-level `SET`: pooled connections would carry it to the next request. |
| Keyword ranking | Built-in `ts_rank_cd` | Real BM25: ParadeDB `pg_search` (or a similar extension), if it can be installed on the managed DB. Ask what their host allows. |
| Language handling | `'simple'` config + `unaccent` | A language-specific config if one exists for the content. Vietnamese has no built-in stemmer, so `simple` + unaccent is the practical choice. |
| Embedding dimension / model | Ask. It is fixed in the column type | Changing it later means a re-embed and a migration. |
| Big-tenant skew | One HNSW index + iterative scans | Partition by tenant or add partial indexes when one tenant has most of the rows. |

## Implementation steps

1. **Roles.** The app connects as `app_user`: not the owner, not superuser, no `BYPASSRLS`. Migrations run as a separate owner role. **Superusers bypass RLS even with `FORCE`.** Many local and dev setups connect as the Docker superuser, and isolation then silently does nothing.
2. **Schema.** Adapt [references/schema.sql](references/schema.sql):
   - `tenant_id uuid NOT NULL DEFAULT current_tenant_id()` on every tenant-owned table;
   - `current_tenant_id()` wraps `NULLIF(current_setting('app.tenant_id', true), '')`. The GUC reverts to `''`, not NULL, after a local set ends. Keep it `LANGUAGE sql STABLE`. Then the policy costs nothing measurable: `count(*)` over one tenant's 1,000 rows took 0.32 ms with RLS and 0.26 ms with a hand-written `WHERE`. The same body as a plpgsql function without a volatility marker is `VOLATILE`. Postgres must then call it for every row, can't use the `tenant_id` index, and scans the whole table: **120 ms, 380× slower**;
   - `UNIQUE (tenant_id, id)` on parents plus **composite FKs** `(tenant_id, parent_id)` on children. RLS doesn't apply to FK checks, so without this a row can point at another tenant's parent;
   - `ENABLE` + `FORCE ROW LEVEL SECURITY` and one policy with both `USING` and `WITH CHECK`;
   - indexes lead with `tenant_id`; GIN on the generated `tsvector`; HNSW on the embedding.
3. **Request path.** Use [references/tenant-db.ts](references/tenant-db.ts): `withTenant(pool, tenantIdFromAuth, fn)` wraps each unit of work in a transaction with the local GUC. Take the tenant id from the verified session or JWT, never from the body or query string. Background jobs carry the tenant id in the job payload and call `withTenant` too.
   RLS itself is free; what a request pays for is round trips. `withTenant` sends `BEGIN` and `set_config` in one call, so a primary-key lookup costs 3 round trips instead of 4, which is 19% faster on a fast network and more across availability zones. The id is inlined into that call, which is safe only because it is checked against a strict UUID pattern first. Keep that check if you port the code.
4. **Hybrid search.** `hybridSearch()` takes the top-N from cosine distance and the top-N from full-text, then fuses them with Reciprocal Rank Fusion (`1/(k+rank)`, k=60). RRF needs no score normalization, and a result found by both retrievers rises to the top. It sets `hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8) so small tenants still get enough candidates after RLS filtering. Return `semantic_rank` and `keyword_rank` so relevance can be debugged and logged into traces. The query embedding goes over the wire as a binary parameter (6 KB instead of ~32 KB of text).
   Small tenants often get an exact scan of their own rows instead of the HNSW index, and that reads every vector. pgvector stores vectors out of line by default; `ALTER TABLE chunks ALTER COLUMN embedding SET STORAGE MAIN` keeps ≤ 2,000-dim vectors in the row. That made exact scans 2–3× faster in the semantic-cache benchmark ([performance](../../docs/performance.md)).
5. **CI guard.** Run [references/rls-audit.sql](references/rls-audit.sql) in CI after migrations. Any table with `tenant_id` that lacks enabled + forced RLS and a policy fails the build, as does an app role with superuser or `BYPASSRLS`.

## Verification (required)

Run against real Postgres with pgvector. [verify/tests/multitenant-postgres.test.ts](../../verify/tests/multitenant-postgres.test.ts) covers all of these:
- Tenant A counts only A's rows; with no tenant set the app role sees 0 rows; a non-superuser owner also sees 0 (FORCE).
- After `withTenant` returns, the same pooled connection has no tenant set. Malformed tenant ids (an SQL-injection string, a trailing newline, an empty string) are rejected before any SQL runs.
- Insert with B's `tenant_id` while in A's context → `42501`; moving a row to B → `42501`; a child pointing at B's parent → `23503`; `UPDATE … WHERE id = <B's id>` affects 0 rows.
- Hybrid search: an unaccented query matches accented text (keyword rank 1); the nearest embedding gets semantic rank 1; results contain only the caller's documents, even when another tenant has identical content.
- The RLS audit returns no rows, and does flag a newly added `tenant_id` table without RLS.

## Record the decision
ADR: isolation model, keyword ranker (ts_rank vs BM25 extension), embedding model and dimension, plus how big tenants will be handled.

## Common mistakes
- Testing isolation as the superuser: everything "works" and nothing is isolated.
- `SET app.tenant_id` (session) instead of local: tenant bleed across pooled requests.
- `SECURITY DEFINER` functions or views owned by a BYPASSRLS role. They skip policies; review each one.
- Filtering vectors *after* `LIMIT` in app code. Isolation holds, but a small tenant gets almost no results.
- Forgetting background workers, cron jobs and admin scripts. With FORCE they see nothing, which is correct, but it surprises people; give them an explicit tenant loop.
- A tenant-id function without a volatility marker (plpgsql defaults to `VOLATILE`): every RLS query becomes a full table scan. Declare it `STABLE`, and prefer `LANGUAGE sql` so it can be inlined.
- Holding a pooled client with no `error` listener. If Postgres ends the connection between two queries (a failover, or `idle_in_transaction_session_timeout` while the request calls something slow), node-postgres emits `error` and the unhandled event crashes the whole process. `withTenant` listens while it holds the client; keep that when porting it. Also add `pool.on('error', log)` for idle clients ([connection-loss.test.ts](../../verify/tests/connection-loss.test.ts)).
- `SET LOCAL hnsw.iterative_scan` on pgvector 0.5–0.7 (still common on managed hosts). Once the library is loaded, `hnsw.` is a reserved prefix, so the statement fails on every *reused* pooled connection and aborts the transaction: an intermittent outage. Set it only when `pg_settings` has it, as `hybridSearch()` does.
