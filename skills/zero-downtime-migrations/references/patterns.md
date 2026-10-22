# Expand / contract recipes

Each recipe keeps the old and the new application version working against the schema at every step. Steps
separated by "deploy" ship in different releases. Run every DDL statement through `runStep` (lock_timeout + retry).

## Add a column

- Nullable, or with a **stable** default (`now()`, a constant): one step. Postgres stores the default in the
  catalog and rewrites nothing.
- With a **volatile** default (`gen_random_uuid()`, `random()`, a serial): add it nullable, backfill, then
  `ALTER … SET DEFAULT`. The other way rewrites the table under an exclusive lock.

## Add a NOT NULL column filled from existing data

1. `ALTER TABLE t ADD COLUMN c text` (nullable)
2. deploy: the app writes `c` on every insert and update
3. `backfill()` the old rows in batches
4. `ALTER TABLE t ADD CONSTRAINT t_c_not_null CHECK (c IS NOT NULL) NOT VALID` (a brief lock, no scan)
5. `ALTER TABLE t VALIDATE CONSTRAINT t_c_not_null` (scans, but writes keep flowing)
6. `ALTER TABLE t ALTER COLUMN c SET NOT NULL` (instant: the validated CHECK proves it)
7. `ALTER TABLE t DROP CONSTRAINT t_c_not_null`

## Rename a column, or change its type

1. add the new column
2. deploy: the app writes both columns
3. backfill the new one
4. deploy: the app reads the new one
5. deploy: the app stops writing the old one
6. drop the old column

A rename in one step breaks every running instance that still uses the old name, during the whole deploy.

## Add a foreign key

1. `ALTER TABLE child ADD CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES parent (id) NOT VALID`
2. `ALTER TABLE child VALIDATE CONSTRAINT child_parent_fk`

## Add a unique constraint or primary key

1. `CREATE UNIQUE INDEX CONCURRENTLY t_email_key ON t (email)`: outside a transaction. If it fails (duplicates),
   drop the INVALID index it leaves behind; `runStep` does this.
2. `ALTER TABLE t ADD CONSTRAINT t_email_key UNIQUE USING INDEX t_email_key`

## Add or drop an index

- Add: `CREATE INDEX CONCURRENTLY`, then check `pg_index.indisvalid`.
- Drop: `DROP INDEX CONCURRENTLY`.

## Drop a column or a table

1. deploy: the app no longer reads or writes it. Tell the ORM to ignore it, or every `SELECT *` still names it.
2. drop it in a later release

## Retrofit tenant isolation (`multitenant-postgres`) on a live table

1. add `tenant_id` nullable
2. deploy: the app writes it
3. backfill it
4. add the NOT NULL in three steps, as above
5. add the composite foreign keys `NOT VALID`, then validate them
6. create the policies
7. `ENABLE` + `FORCE ROW LEVEL SECURITY` with `runStep`: a brief exclusive lock

Before the last step, test the app as the non-superuser role: from then on, a query without a tenant returns
nothing.

## Long backfills

- Run them as jobs (`job-queue`), not inside the deploy.
- Keep batches small (1,000–10,000 rows) and pause between them.
- Watch replica lag.
- Make each batch idempotent, so an interrupted run simply starts again.
