---
name: zero-downtime-migrations
description: Change a live Postgres schema without stalling the app — lock_timeout with retries so a waiting ALTER can't queue every query behind it, CREATE INDEX CONCURRENTLY (and cleanup of the INVALID index a failed build leaves), NOT VALID then VALIDATE for constraints, NOT NULL without a table scan, expand/contract for renames and type changes, batched backfills, and a migration linter for CI. Use whenever the user writes or reviews a migration (Prisma, Drizzle, Knex, TypeORM, Rails, Django, Flyway, Liquibase, raw SQL), adds an index, column, constraint or NOT NULL to an existing table, renames or drops something, backfills data, or mentions downtime during deploys, "migration bị treo", "khóa bảng", "deploy không downtime".
---

# Zero-downtime migrations

Most migration outages don't come from slow statements. They come from **lock waits**. An `ALTER TABLE` needs an
exclusive lock, so it waits behind any open transaction on the table, such as a long report or an idle-in-transaction
session. While it waits, every new query on that table queues behind it. One harmless `ADD COLUMN` that waits a
minute is a minute of total outage. The other cause is statements that hold a heavy lock for a long time: a
non-concurrent index build, or a table rewrite.

Every skill in this kit ships SQL, and agents write migrations constantly. This skill makes each one safe to run
against traffic.

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Who runs migrations | One CI/CD step before the deploy, never every app instance at startup | Instances racing to migrate at boot is how a deploy gets stuck in a lock queue. |
| `lock_timeout` | 2 s, retried with backoff, about 10 attempts | Bounds how long the app can stall. Lower it for hot tables. |
| Release shape | Expand / contract: add → dual-write → backfill → switch reads → drop, over several releases | Old and new code must both work during a rolling deploy. Renames and type changes in one step break that. |
| Backfills | Batches of 1,000–10,000 rows, walked by primary key, run as a job | A single `UPDATE` over the table holds row locks for minutes and floods replicas. |
| Migration tool | Whatever the project uses (Prisma, Drizzle, Knex, Rails, Flyway…) | Keep its file format. Route DDL through `runStep`'s settings (or a `SET lock_timeout` header), and run `lintMigration` on new files in CI. |

## Implementation steps

1. **Lint every new migration in CI** with `lintMigration(sql)` from [references/lint.ts](references/lint.ts).
   - **Errors:** a non-concurrent `CREATE INDEX` on an existing table; a volatile default or serial column; a
     `NOT NULL` column without a default (it fails outright on a table with rows); a foreign key or CHECK without
     `NOT VALID`; `UNIQUE` without `USING INDEX`; `VACUUM FULL`, `CLUSTER` or a non-concurrent `REINDEX`;
     `CONCURRENTLY` inside a transaction.
   - **Warnings** (need a human OK): type changes, `SET NOT NULL`, renames and drops, unbatched `UPDATE`/`DELETE`,
     `LOCK TABLE`, `TRUNCATE`.
   - Statements on a table created in the same migration are exempt.
   - A quoted identifier is one name even when it holds a `;` (`"orders;archive"`). Splitting there hid the
     statement after it from every rule.
2. **Run DDL with `runStep`** from [references/migrate.ts](references/migrate.ts).
   - Each statement gets a `lock_timeout`, and on `55P03` it is retried with jittered backoff.
   - `CREATE` / `DROP` / `REINDEX … CONCURRENTLY` runs outside a transaction. If it fails, the INVALID index it left
     behind is dropped, so a retry can't trip over the name and writes don't keep maintaining a useless index. An
     unnamed `CREATE INDEX CONCURRENTLY ON t (c)` gets a generated name; its INVALID index is the one that wasn't on
     the table before the attempt. Missed, each retry left another (`t_c_idx`, `t_c_idx1`, …).
   - `attempts` and `baseDelayMs` must be integers, checked before anything runs: NaN attempts retried forever.
   - With another migration tool, set `lock_timeout` at the top of each migration and retry the deploy step.
3. **Follow the recipes** in [references/patterns.md](references/patterns.md) for: NOT NULL in three steps, rename
   or type change via a new column, foreign keys and unique constraints, dropping columns, retrofitting tenant
   isolation (`multitenant-postgres`).
4. **Backfill with `backfill()`.** It updates short batches walked by primary key, pauses between them, and resumes
   from `lastId` or from `where new_col IS NULL`. Run long ones as a job (`job-queue`). A batch that loses a
   deadlock against the app, or hits a serialization failure or a lock timeout, is retried (`retries`, default 5).
   If it still gives up, the error carries `lastId`: resume with `afterId: err.lastId`.
   Pass `signal` (a job's `ctx.signal`, or one aborted on SIGTERM): the backfill stops after the current batch, and
   the error carries `lastId` the same way. `onBatch` reports progress only; it can't stop the backfill.
   `batchSize` must be a positive integer and `retries` and `pauseMs` integers of 0 or more: `batchSize: 0`
   "finished" at once with nothing done, and NaN retries retried a deadlocked batch forever. Durations stop at
   2,147,483,647 ms: Node runs a longer pause after 1 ms, and Postgres refuses a longer `lock_timeout`.
   - The ids a batch **selected** decide where the next batch starts and whether it was the last. On a table the app
     deletes from, a batch that waited for a row lock skips the row deleted meanwhile and updates fewer rows than it
     selected. Ending on that count stopped the backfill after its first batch, reported as finished, with most of
     the table still to do.
   Copy `hooks.ts` and `pg-transaction.ts` along with `migrate.ts`: they are the kit's shared building blocks.
5. **Check before shipping.**
   - Every new index has `pg_index.indisvalid = true`.
   - No migration holds an exclusive lock longer than a second on production-sized data. Restore a copy and time it.

## Verification (required)

Against real Postgres. [verify/tests/skills/zero-downtime-migrations.test.ts](../../verify/tests/skills/zero-downtime-migrations.test.ts) covers:
- **A waiting `ALTER` stalls reads**: behind a 700 ms report, a read waited over 500 ms. With `runStep` and
  `lock_timeout` 100 ms, a read waited under 250 ms, and the step retried until the report ended.
- `CREATE INDEX` makes an insert wait through most of the build. With `CONCURRENTLY`, the insert takes under 100 ms.
- A failed `CREATE UNIQUE INDEX CONCURRENTLY` (duplicates) leaves an INVALID index in plain Postgres. `runStep`
  leaves none.
- NOT NULL in steps:
  - `VALIDATE` runs while a write transaction is open, and `SET NOT NULL` can't (lock timeout);
  - afterwards, Postgres reports that the validated CHECK let it skip the scan.
- Which changes rewrite the table, read from `pg_relation_filenode`:
  - `DEFAULT now()`: no;
  - `DEFAULT gen_random_uuid()`: yes;
  - `int → bigint`: yes;
  - `varchar → text`: no.
- `backfill` updates in batches, and an interrupted run resumes with only the rows still to do.
- The linter flags each hazard in a fixture migration and leaves the safe statements alone.
- A batch that hits a deadlock is retried, and all 2,500 rows are backfilled; `ADD COLUMN … NOT NULL` without a
  default is flagged, with a default it isn't ([regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts)).
- [regressions/round-6.test.ts](../../verify/tests/regressions/round-6.test.ts): an unnamed concurrent unique index
  that fails leaves no INVALID index; a quoted identifier with a `;` stays in its statement; `TRUNCATE` is flagged;
  NaN attempts and retries and `batchSize: 0` are `RangeError`s.
- [regressions/round-7.test.ts](../../verify/tests/regressions/round-7.test.ts): a backfill of 25 rows in batches of 10,
  with the app deleting one row the first batch waits for, updates the other 24 (before: 9, then "done"); a `pauseMs`
  Node can't schedule is a `RangeError`.

How to write these tests so they prove something:
- Hold a lock from a second connection (an open transaction) and time a third query. A migration that runs fine on
  an idle database proves nothing.
- Read lock behaviour from the database (filenode, `pg_index.indisvalid`, `55P03`), not from the docs.

## Record the decision
ADR: who runs migrations and when, the `lock_timeout` value, the expand/contract stages of each risky change, how
backfills are run and monitored.

## Common mistakes
- **DDL without `lock_timeout`.** On 1,000,000 rows behind a 1 s report, a read arriving after the `ALTER` waited
  1,005 ms. With `lock_timeout` 100 ms and retries, it waited 52 ms, and the column still landed
  ([performance](../../docs/performance.md)).
- **`CREATE INDEX` without `CONCURRENTLY`**: an insert during the 1.6 s build waited 1,524 ms. Concurrently, it
  waited 2 ms.
- **A volatile default on a new column** (`gen_random_uuid()`, `random()`, a serial) rewrites every row while holding
  an exclusive lock: 3.9 s on 1,000,000 rows. A stable default such as `now()` took 1 ms.
- `SET NOT NULL` straight away: a full scan under an exclusive lock. With a validated `CHECK` first, the exclusive
  part is instant.
- Retrying a failed `CREATE INDEX CONCURRENTLY` without dropping the INVALID index it left: the retry fails on the
  name. Writes pay to maintain an index nobody can use.
- Renaming or dropping a column in the same release that stops using it: instances still running the old code fail
  for the whole rollout.
- Running migrations from every instance at startup, or inside the request path.
- One `UPDATE` for the whole table "because it's just a data fix".
- **A backfill nothing can stop.** Run inside a job (or during a deploy), it keeps writing after the job lost its
  lease, while a second worker starts the same backfill. Pass `signal` (a job's `ctx.signal`): it stops after the
  current batch, and the error carries `lastId`. Throwing from `onBatch` doesn't stop it: a hook can't change the
  outcome of the work it watches.
- Splitting a migration on every `;`. A function body in `$fn1$ … $fn1$` quotes, or an `E'it's; …'` string, is one
  statement; the linter's splitter knows both.
