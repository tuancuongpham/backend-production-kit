---
name: webhook-ingestion
description: Receive third-party webhooks reliably — signature verification, idempotent storage, async processing with exponential backoff, dead-letter queue, replay tooling and scheduled reconciliation. Use whenever the user integrates payment or SaaS callbacks (Stripe, VNPay IPN, MoMo, ZaloPay, PayOS, Shopify, GitHub, Slack, Zalo OA…), writes a "/webhook" or "/ipn" endpoint, sees duplicate or missing payments/orders, or asks about "webhook bị gọi trùng", "mất webhook", "đối soát", "retry webhook".
---

# Reliable webhook ingestion

Providers deliver **at least once**, out of order, sometimes never, and they retry when you're slow. So treat the endpoint as a write-ahead log, not as business logic:

```
POST /webhooks/:provider
  → verify signature on the RAW body (reject → 400/401)
  → INSERT INTO webhook_inbox … ON CONFLICT (provider, event_id) DO NOTHING
  → 2xx immediately (in the provider's required response format)
worker (separate process/loop)
  → claim rows FOR UPDATE SKIP LOCKED
  → handler(row, tx) + mark done in ONE transaction
  → on error: attempts++, next_attempt_at = now + backoff(jitter); after N → 'dead' + alert
replay CLI → dead → pending          reconcile cron → provider API → ingest missing
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Which providers + their signature scheme | Read each provider's docs | Stripe: `t=…,v1=…` over `"{t}.{body}"`; VNPay: HMAC-SHA512 over sorted query params; MoMo: HMAC-SHA256 over a documented field order; GitHub: `sha256=` HMAC of body. Never guess a scheme. |
| Response contract | 2xx | Some providers expect a specific body (VNPay IPN expects `{"RspCode":"00","Message":"Confirm Success"}`). Get this wrong and they retry forever. |
| Event id when the provider has none | `sha256(provider + raw body)` | Or a natural key such as the transaction ref plus status. |
| Max attempts / backoff | 8 attempts, 2 s base, 1 h cap | Roughly 4 h total. Tune to the provider's retry window. |
| Who gets alerted on dead letters | Ask | A dead letter means money or state is wrong until a human acts. |
| Reconciliation source + cadence | Every 15 min over the last 24 h | Needs a provider list/search API, such as Stripe `events.list` or VNPay `querydr`. Without one, reconcile against your own pending orders. |
| Queue backend | Postgres inbox table | Move to a broker only when Postgres becomes the bottleneck. The inbox table still stays as the dedup record. |

## Implementation steps

1. **Table.** Add [references/inbox.sql](references/inbox.sql) as a migration. `UNIQUE (provider, event_id)` is the idempotency guarantee, and partial indexes keep the claim queries cheap.
2. **Endpoint.** Read the raw body *before* any JSON middleware, because signature checks fail after a re-serialization. Verify with `verifyTimestampedSignature` or `verifyHmacHex` from [references/webhooks.ts](references/webhooks.ts) (constant-time compare, replay window). Then call `ingest()`, return the provider's success response, and do **no business logic inline**: slow handlers cause provider timeouts, which cause more duplicates.
   A `toleranceSec` that isn't a positive number throws: read from an unset environment variable it is NaN, and `age > NaN` is never true, so a request captured a year ago verified.
   Exception: some providers want the response to carry a validation result (VNPay `RspCode` 01 = order not found, 04 = invalid amount). Do those cheap *reads* inline, compared against the server-side stored amount, then ingest and reply. The crediting still happens in the worker.
   **Redirect/return URLs** (VNPay `vnp_ReturnUrl`, Stripe success URL) are user-controlled and must be **read-only**: show status, never credit. Otherwise they become a second, unsigned path to double-credit.
3. **Handlers.** Register them as `'provider:event_type'` (or `'provider:*'`). Each handler gets the transaction client, so DB side effects and the "done" mark commit together. For external side effects (send email, call an API), pass an idempotency key such as `` `${provider}:${event_id}` ``.
   **Ordering:** events can arrive out of order, for example `refund` before `payment.succeeded`. Make handlers state-based: re-fetch the object from the provider API, or compare `event.created`/version with what's stored and ignore older events.
   **Throughput:** handlers are I/O-bound, so run several at once. With ~5 ms handlers, 8 loops drain 200 events in about 0.2 s instead of 1.5 s for one. This is safe only when handlers lock or conditionally update the object they change (state-based, as above), because two events for the same order can now run at the same time.
4. **Worker.** Start `createInboxWorker(...).run({ loops: 4–8, signal })` in the worker process:
   - **Independent loops, small batches** (`batchSize` 2–5). A batch processed in parallel lanes (`concurrency`) finishes only when its slowest row does. When 1 handler in 20 waited 200 ms on a provider, 8 independent loops drained 200 events in 0.58 s; one loop with 8 lanes over 50-row batches needed 1.04 s.
   - **Graceful stop.** On SIGTERM, abort `signal` and `await` the returned promise in the shutdown hook (`service-hardening`). The loops finish the rows they claimed instead of leaving them in `processing` until `stuckAfterSec`.
   - **Several instances are safe** thanks to `SKIP LOCKED`. Rows stuck in `processing` after a crash are re-claimed after `stuckAfterSec`.
   - **A slow handler is never run twice at once.** Every claim gets a new `lease_id`, and the handler's transaction starts by locking its own row as that lease holder (`SELECT … FOR UPDATE`). While the lock is held, the claim's `SKIP LOCKED` passes over the row even after `stuckAfterSec`. A worker that lost its row meanwhile gets the outcome `lost` and can't overwrite the new owner's result. That costs one round trip per event.
   - Copy `hooks.ts`, `pg-transaction.ts`, `pg-values.ts` and `worker-loop.ts` along with `webhooks.ts`: they are the kit's shared building blocks, identical in every skill that has them. `pg-values.ts` stores a NUL or half an emoji in a payload as U+FFFD. Without it, Postgres refuses the event and the provider retries it forever.
   - Settings are checked at startup. A NaN retry delay made every failure fail to record itself, so the row was never dead-lettered, only claimed again; NaN `loops` started no loop at all.
   - **The claim stays cheap under a backlog.** It takes stuck rows, then due rows, each through its own partial index in order: about 0.6 ms with 200,000 events due.
   - `processOnce()` is the single tick underneath, for tests and custom schedulers. Optionally wake the loops with `LISTEN/NOTIFY`; keep polling (`idleMs`) as the fallback.
5. **DLQ + replay.** The `webhook_dead_letters` view feeds a dashboard or alert. Wrap `replay()` in a CLI or admin endpoint, by ids, provider or type, so it can be used after a fix ships. Ship it as code; a SQL snippet in the README is not a replay tool at 3 a.m.
6. **Reconciliation.** Run `reconcile(pool, listFromProvider(since))` on a schedule. Export `missed` as a metric; consistently > 0 means webhook delivery is broken.
7. **Retention.** Run `pruneInbox(pool, { olderThanDays: 30 })` daily. It deletes `done` rows in batches through a partial index and never touches dead letters. The window must be longer than the provider's retry period (Stripe retries for 3 days), because a deleted row is a forgotten dedup key.
8. Trace context: put `traceparent` into the payload or headers you store, so processing joins the original request trace (see `llm-observability`).

## Verification (required)

Against real Postgres. [verify/tests/skills/webhook-ingestion.test.ts](../../verify/tests/skills/webhook-ingestion.test.ts) and the regression tests in [regressions/round-2.test.ts](../../verify/tests/regressions/round-2.test.ts) cover:
- Signatures: valid passes; tampered body, wrong secret, stale timestamp, missing or malformed header, and wrong-length hex all fail.
- The same event delivered twice → 1 row, handler effect applied once, including when the duplicate arrives *after* processing.
- A handler that writes then throws → the write is rolled back; status `pending`, `attempts` 1, `next_attempt_at` in the future; not re-run before due; eventually `done`.
- After `maxAttempts` → `dead`, `onDead` fires, the DLQ view shows it; `replay` → processed successfully.
- 4 concurrent workers × 60 events → exactly 60 effects, all `done`.
- A row stuck in `processing` with an old `locked_at` is re-claimed. One claim takes the stuck row and due rows, never more than `batchSize` in total. Unknown event type → acknowledged as `ignored`.
- A handler slower than `stuckAfterSec` while a second worker polls → credited once, not twice. A worker whose connection died after another worker took over the event → `lost`, and the event stays `done` ([regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts)).
- `run()` with 4 loops processes 4 events at once; aborting it mid-batch leaves no row in `processing`, and a restart drains the rest with each event applied once.
- Reconciliation ingests only missing events and reports the count. `pruneInbox` deletes old `done` rows only, never recent ones or dead letters.
- A `toleranceSec` of NaN throws instead of accepting a year-old signature, and NaN retry delays are refused at
  startup ([regressions/round-6.test.ts](../../verify/tests/regressions/round-6.test.ts)).

How to write these tests so they prove something:
- **Sign test payloads with the provider's own tooling**: Stripe's `stripe.webhooks.generateTestHeaderString`, or a payload and signature captured from the provider's sandbox. A test that signs with the same HMAC code the verifier uses passes even when both share a bug (wrong field order, wrong encoding).
- **Assert "processed once" on the business effect, through the worker**: run `processOnce()` after each delivery and count credits, enrollments or ledger rows. An in-memory inbox that "stores once" doesn't prove the handler applies once.
- Add an **amount-mismatch** case (amount ≠ server-side stored amount → rejected, nothing credited) and a **concurrent duplicate** case (N deliveries in parallel → one effect).

Also run the provider's own test tooling (Stripe CLI `stripe trigger`, the VNPay sandbox) once against the real endpoint.

## Record the decision
ADR: inbox-in-Postgres vs broker, retry policy, ordering strategy, reconciliation cadence, alert owner.

## Common mistakes
- Parsing JSON before verifying: the signature no longer matches, so someone "temporarily" disables verification.
- Doing the work in the request: timeouts, then duplicate deliveries, then double credits.
- Returning 500 for duplicates or unknown types: the provider retries forever.
- Comparing signatures with `===`, which leaks timing.
- No reconciliation: the one missed `payment.succeeded` becomes a support ticket a week later.
- One claim query for "pending OR stuck" sorted by time. Postgres can't use either index's order for an `OR`, so every claim fetches and sorts the whole due backlog: 1 ms with 2,000 events due, 56 ms with 200,000. The worker slows down exactly when it has the most to catch up on.
- Stopping workers without waiting for them: every deploy strands the claimed rows in `processing` for `stuckAfterSec`.
- Deleting processed rows sooner than the provider's retry window: a late redelivery is no longer recognized as a duplicate.
- Re-claiming "stuck" rows by age alone. A handler that is merely slow gets a second run alongside the first, both commit, and the payment is credited twice. Only the holder of the current claim may finish a row.
- A replay window read with `Number(process.env.WEBHOOK_TOLERANCE)`. Unset, it is NaN, and no timestamp is ever too
  old: replay protection is off without a single error.
- Comparing signatures with `Buffer.from(sig, 'hex')` alone. It stops at the first character that isn't hex, so a
  valid signature with anything appended (`…0`, `…z`) still compares equal. Check that it is whole hex first.
- An `onDead` alert that throws, or an async one that rejects while Slack is down. Called bare, it turns a recorded
  dead letter into an exception, or an unhandled rejection that ends the process. The kit calls every hook through
  `callHook` (`hooks.ts`): the dead letter stands whatever the alert does.
