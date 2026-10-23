---
name: data-retention-and-erasure
description: Handle personal data over its lifetime — one inventory of where each person's data lives, erasure requests that delete or anonymize every table in one transaction and retry external stores (caches, search, traces, vendors) until done with a durable record, access-request exports, per-table retention in batches, and a CI audit that flags new personal-looking columns nobody classified. Use whenever the user implements "delete my account", GDPR or Vietnam's personal data rules (Nghị định 13, Luật Bảo vệ dữ liệu cá nhân), data retention policies, tenant offboarding, data export requests, or mentions right to be forgotten, PII retention, "xóa dữ liệu khách hàng", "lưu trữ dữ liệu bao lâu", "yêu cầu xóa tài khoản".
---

# Data retention and erasure

A person's data doesn't live in the `users` table. It lives in orders, tickets, chat logs, audit trails, webhook
payloads, the semantic cache (the embedding of their question is their data too), traces, search indexes and Redis.
A deletion that only removes the `users` row leaves the rest behind. Deleting everything breaks accounting. Usually
the request just fails halfway on a foreign key.

The fix is one **inventory**: for each table, where the subject's id is, which columns are personal, and what erasure
means for it (delete or anonymize). Erasure, export, retention and the CI audit are all driven from it.

```
requestErasure(userId)
  one transaction over the inventory, children first:  delete | anonymize (keep the amounts, drop the person)
  erasure_requests row: what was done, when, due date
  external stores (cache, search, traces, vendor APIs) → tried; failures stay pending → processPending() retries
  done → subject_id cleared, only sha256(pepper‖id) kept as proof
exportSubject(userId)  → every inventoried row, by table (access request)
runRetention()         → per-table batched deletes past each window
auditInventory()       → personal-looking columns that no one has classified → fail CI
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Delete or anonymize, per table | Delete; anonymize where a law or the business needs the record (invoices, payments, security audit) | Write the reason in `keepReason`. Anonymize means removing the link to the person, not masking a few characters. |
| Deadline | `dueDays: 30` (GDPR: one month) | Check what applies: for Vietnam, Decree 13/2023 and the 2025 Personal Data Protection Law. Set `due_at` and alert before it. |
| Retention per table | Chat logs and support conversations 30–90 days; webhook payloads and job history 30 days; usage and billing as accounting requires | Each skill's prune function covers its own tables. The inventory makes the policy explicit and auditable. |
| External copies | Every cache, index, vendor and trace store gets an `ExternalStore.erase` | If a store can't erase per person (some log or trace backends), make its retention short and say so in the record of processing. |
| Backups | Keep them short-lived. After any restore, re-run erasures | Re-erase by hashing each restored subject id and matching it against `erasure_requests.subject_hash`. |
| Identity proof | The authenticated account, or a verified out-of-band request | Erasure is an attack too: make sure the requester is the person. |

## Implementation steps

1. **Inventory.** Write the `InventoryEntry[]` from [references/erasure.ts](references/erasure.ts) for every table
   holding personal data: `subjectColumn`, `personal` columns, `onErase`, `anonymize` expressions, retention. Order
   children before parents: entries run in order inside one transaction.
   - `createDataLifecycle` checks the inventory at startup (`checkInventory`) and refuses an unsafe one. An
     `anonymize` entry must overwrite every `personal` column and the subject column, or the kept row still
     identifies the person. Names must be plain identifiers, and retention needs a time column.
   - Copy `pg-transaction.ts`, `pg-values.ts` and `with-timeout.ts` along with `erasure.ts`: the kit's shared transaction helper, the one that makes stored values hold any text, and the deadline each external store gets.
2. **Tables.** Add [references/erasure.sql](references/erasure.sql). The `erasure_requests` row records what was done
   per table and per store. Once every store is done it keeps only the hash.
3. **Wire the request path.** "Delete my account" (after re-authentication) calls `requestErasure(userId)`, and the
   user is told the deadline. Schedule `processPending()` (a `job-queue` recurring job), and alert on requests close
   to `due_at`. Any number of instances may run it: each request is leased to one run at a time (`leaseSec`, default
   300 s, longer than the slowest store), and only that run writes the outcome back.
4. **External stores.** Implement `erase(subjectId, signal)` for each one:
   - Redis: SCAN + DEL by key pattern, which is why keys carry the user or tenant (`cache-stampede`);
   - the search index: delete by query;
   - Langfuse and traces: their delete API, or short retention;
   - the semantic cache: delete by user scope.

   Make each one idempotent, because it is retried. Each call gets `storeTimeoutMs` (default 30 s) and a `signal`
   that aborts then: pass it to the client. A store that never answers (a black-holed search cluster) used to hang
   the user's "delete my account" request, and every request claimed in the same batch behind it. Now it counts as
   pending and is retried. The stores' timeouts together must fit in `leaseSec`; the constructor checks it, and
   refuses NaN settings.
5. **Access requests.** `exportSubject(userId)` → a JSON bundle per table, delivered to the verified requester.
6. **Retention.** Schedule `runRetention()` daily. It deletes in batches by `ctid`, so long deletes don't hold
   locks or flood replicas.
   - Tables partitioned by time are safe: a `ctid` is unique only within one partition, so the DELETE repeats the
     retention condition. Deleting by `ctid` alone, a run over an events table partitioned by month deleted the
     current partition's rows that happened to share the expired rows' `ctid`s, data still inside its window.
   - A batch ends the loop when it *selected* fewer rows than `batchSize`, not when it deleted fewer, since rows the
     app deletes meanwhile don't mean the table is done. `batchSize` must be a positive integer.
7. **CI guard.** Run `auditInventory()` against the migrated test database. A new column named `email`, `phone`,
   `full_name`, `address`, `ip_address`, `cccd`, `so_dien_thoai`… must be added to the inventory or marked
   `reviewed`. Free-text columns can't be judged by name: decide them when the table is designed.

## Verification (required)

Against real Postgres and Redis. [verify/tests/skills/data-retention-and-erasure.test.ts](../../verify/tests/skills/data-retention-and-erasure.test.ts) covers:
- **After erasing Alice, a scan of every text, json and inet column in the database finds none of her email, name,
  phone or id.**
  - The invoice totals are unchanged, because orders were anonymized, not deleted.
  - Her Redis keys are gone, and Bob's are untouched.
  - The request keeps only the hash.
- A store that fails twice is retried by `processPending()` until done. Until then the request stays open and keeps
  the id it needs.
- One failing table rolls back the whole erasure: nothing half-erased, no request recorded.
- An access request exports every inventoried row about the person.
- Retention deletes 1,200 old chat messages in batches of 500, and keeps recent ones and tables without a window.
- The audit flags `email`, `ho_ten` and `so_dien_thoai` on a new table, and passes once they're classified.
- [regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts):
  - two instances processing the same request at once can't reopen it with the subject already forgotten;
  - `processPending` reports the requests it completed correctly when more than one batch is open;
  - an `anonymize` entry that leaves `shipping_address` in place is refused at startup.
- [regressions/round-6.test.ts](../../verify/tests/regressions/round-6.test.ts): a store that never answers is timed
  out, so `requestErasure` and `processPending` return with it still pending.
- [regressions/round-7.test.ts](../../verify/tests/regressions/round-7.test.ts): on a table partitioned by time,
  retention deletes the 5 expired rows and keeps the 5 fresh ones that share their `ctid`s (before: all 10 gone);
  `runRetention(0)` and a `storeTimeoutMs` Node can't schedule are refused.

How to write these tests so they prove something:
- Prove absence by searching **every** text-like column for the person's identifiers, not only the tables you
  remembered.
- Put their identifiers into free text as well (a ticket body that says "call me at 090…"). That is where real data
  hides.

## Record the decision
ADR: the inventory (table, delete or anonymize, legal basis for keeping), retention per table, deadline, external
stores and how each is erased, backup policy.

## Common mistakes
- Deleting the `users` row and calling it done. Their email still sits in orders, tickets, chat logs and cache keys.
- `ON DELETE CASCADE` everywhere: invoices and payment records needed for accounting vanish with the account.
- Anonymizing by masking (`a***@example.com`) while keeping the user id: still personal data.
- Erasing table by table without a transaction. The first foreign-key error leaves the person half-deleted, and no
  record of what happened.
- Forgetting derived data: embeddings of their questions, search index documents, analytics events, traces.
- Keeping the subject's id in the erasure log forever. The log then re-identifies the person it was meant to forget.
- Anonymizing some personal columns and forgetting one. The erasure "succeeds" and the address stays.
- Letting two schedulers process the same request. The slower one wrote back "pending" after the faster one had
  completed it and cleared the subject id, and the request then retried forever with nobody to erase.
- No retention: data kept "just in case" is data you must find, export and erase later.
- Forgetting the operational tables that hold the subject's id: idempotency keys (their `scope`), job payloads,
  outbox events, the webhook inbox, audit logs. Inventory each one with its retention. The deletion request's own
  idempotency key keeps the id until it expires (24 h by default), so that a retried tap still gets its answer
  ([journey](../../verify/tests/journeys/data-rights.test.ts)).
- Erasing a cached copy by letting it expire. Until then the deleted person's profile is still served; list the
  cache as an external store whose `erase` invalidates the key.
- Awaiting an external store with no deadline. One that never answers holds the deletion request open, and the
  user's request with it.
