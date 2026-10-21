-- Agent-safe read access for Postgres.
-- Run as the schema owner (migration role). Idempotent.
-- Adapt the views to your tables: expose only the columns the agent needs, mask PII.
-- The demo assumes public.customers(id, tenant_id, email, phone, full_name, city, created_at)
-- and public.orders(id, tenant_id, customer_id, status, total_amount, note, created_at).

-- 1. Roles: a NOLOGIN group that holds grants, and a LOGIN role the executor uses.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_reader') THEN
    CREATE ROLE agent_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_app') THEN
    -- Password is set separately from your secret manager:
    --   ALTER ROLE agent_app PASSWORD '<from secret store>';
    CREATE ROLE agent_app LOGIN;
  END IF;
END $$;

GRANT agent_reader TO agent_app;

-- Defense in depth. read_only is a soft guard (a session can SET it off); grants below are the boundary.
ALTER ROLE agent_app SET default_transaction_read_only = on;
ALTER ROLE agent_app SET statement_timeout = '5s';
ALTER ROLE agent_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE agent_app SET lock_timeout = '1s';
ALTER ROLE agent_app SET search_path = agent_api;
ALTER ROLE agent_app CONNECTION LIMIT 10;

-- 2. A dedicated schema holding only what the agent may read.
CREATE SCHEMA IF NOT EXISTS agent_api;
REVOKE ALL ON SCHEMA agent_api FROM PUBLIC;

-- security_barrier: stops user-supplied functions in WHERE from seeing rows the view filters out.
-- The tenant filter uses a GUC set by the trusted executor. It is NOT a boundary if the
-- model can run raw SQL (it could call set_config) — see SKILL.md.
CREATE OR REPLACE VIEW agent_api.customers WITH (security_barrier = true) AS
SELECT
  c.id,
  c.tenant_id,
  regexp_replace(c.email, '^(.).*(@.*)$', '\1***\2') AS email_masked,
  CASE WHEN c.phone IS NULL THEN NULL ELSE '*******' || right(c.phone, 3) END AS phone_masked,
  c.city,
  c.created_at
FROM public.customers c
WHERE c.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;

CREATE OR REPLACE VIEW agent_api.orders WITH (security_barrier = true) AS
SELECT
  o.id,
  o.tenant_id,
  o.customer_id,
  o.status,
  o.total_amount,
  o.created_at
  -- o.note intentionally omitted: free text written by end users is a prompt-injection
  -- and PII vector. Expose it through a separate, explicitly reviewed tool if needed.
FROM public.orders o
WHERE o.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid;

-- 3. Grants: SELECT on the views only. Nothing on base tables.
GRANT USAGE ON SCHEMA agent_api TO agent_reader;
GRANT SELECT ON agent_api.customers, agent_api.orders TO agent_reader;
REVOKE ALL ON public.customers, public.orders FROM agent_reader, agent_app;
