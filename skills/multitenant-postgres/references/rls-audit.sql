-- CI guard: every table with a tenant_id column must have RLS enabled AND forced AND at least one policy that
-- filters by tenant, and the application role must not bypass RLS. All three queries must return zero rows.

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

-- 3. Permissive policies on tenant tables that don't filter by tenant. Permissive policies are OR-ed, so one
--    USING (true) or WITH CHECK (true) next to a correct policy opens every row (or every write). Adjust the
--    function name if your policies call another one.
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       p.polname AS policy_name,
       pg_get_expr(p.polqual, p.polrelid) AS using_expr,
       pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
WHERE p.polpermissive
  AND ((p.polqual IS NOT NULL AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%current_tenant_id()%')
    OR (p.polwithcheck IS NOT NULL AND pg_get_expr(p.polwithcheck, p.polrelid) NOT LIKE '%current_tenant_id()%'))
ORDER BY 1, 2, 3;
