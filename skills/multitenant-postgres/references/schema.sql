-- Multi-tenant schema with Row-Level Security + hybrid (keyword + vector) search.
-- Run as the owner/migration role. Idempotent. The application connects as app_user,
-- which must NOT be the owner, a superuser, or have BYPASSRLS.

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector >= 0.8 recommended (iterative index scans)
CREATE EXTENSION IF NOT EXISTS unaccent; -- accent-insensitive keyword search ("thanh toan" ~ "thanh toán")

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN; -- password from your secret manager: ALTER ROLE app_user PASSWORD '...'
  END IF;
END $$;

-- unaccent() is STABLE, generated columns need IMMUTABLE: the standard wrapper.
CREATE OR REPLACE FUNCTION kit_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- NULLIF: after a SET LOCAL ends, the GUC reverts to '' (not NULL) on that connection.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE IF NOT EXISTS tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  title      text NOT NULL,
  source_url text,
  version    int  NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id) -- target for composite FKs: children can't point at another tenant's parent
);

CREATE TABLE IF NOT EXISTS chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT current_tenant_id(),
  document_id uuid NOT NULL,
  ordinal     int  NOT NULL DEFAULT 0,
  content     text NOT NULL,
  -- 'simple' config: no stemming, works for Vietnamese and mixed-language text.
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('simple', kit_unaccent(content))) STORED,
  embedding   vector(1536) NOT NULL, -- match your embedding model's dimension
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chunks_tenant_idx    ON chunks (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx       ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- Row-Level Security. FORCE makes the policy apply to the table owner too, so a
-- migration/admin script that forgets to set a tenant sees nothing instead of everything.
ALTER TABLE tenants   ENABLE ROW LEVEL SECURITY; -- not FORCEd: the owner provisions tenants
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE  ROW LEVEL SECURITY;
ALTER TABLE chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks    FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON documents;
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON chunks;
CREATE POLICY tenant_isolation ON chunks
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT ON tenants TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, chunks TO app_user;
