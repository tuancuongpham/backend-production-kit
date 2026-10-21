-- CI guard: every table with a tenant_id column must have RLS enabled AND forced AND at least one policy,
-- and the application role must not bypass RLS. Both queries must return zero rows.

-- 1. Tables that leak across tenants.
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND (NOT c.relrowsecurity
       OR NOT c.relforcerowsecurity
       OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
ORDER BY 1, 2;

-- 2. App roles that would ignore RLS entirely.
SELECT rolname
FROM pg_roles
WHERE rolname IN ('app_user', 'agent_app')
  AND (rolsuper OR rolbypassrls);
