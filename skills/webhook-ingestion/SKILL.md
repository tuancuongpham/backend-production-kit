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
   Exception: some providers want the response to carry a validation result (VNPay `RspCode` 01 = order not found, 04 = invalid amount). Do those cheap *reads* inline, compared against the server-side stored amount, then ingest and reply. The crediting still happens in the worker.
   **Redirect/return URLs** (VNPay `vnp_ReturnUrl`, Stripe success URL) are user-controlled and must be **read-only**: show status, never credit. Otherwise they become a second, unsigned path to double-credit.
3. **Handlers.** Register them as `'provider:event_type'` (or `'provider:*'`). Each handler gets the transaction client, so DB side effects and the "done" mark commit together. For external side effects (send email, call an API), pass an idempotency key such as `` `${provider}:${event_id}` ``.
   **Ordering:** events can arrive out of order, for example `refund` before `payment.succeeded`. Make handlers state-based: re-fetch the object from the provider API, or compare `event.created`/version with what's stored and ignore older events.
4. **Worker.** Call `createInboxWorker(...).processOnce()` on an interval. Optionally wake it with `LISTEN/NOTIFY`, keeping polling as the fallback. Several instances are safe thanks to `SKIP LOCKED`. Rows stuck in `processing` after a crash are re-claimed after `stuckAfterSec`.
5. **DLQ + replay.** The `webhook_dead_letters` view feeds a dashboard or alert. Wrap `replay()` in a CLI or admin endpoint, by ids, provider or type, so it can be used after a fix ships. Ship it as code; a SQL snippet in the README is not a replay tool at 3 a.m.
6. **Reconciliation.** Run `reconcile(pool, listFromProvider(since))` on a schedule. Export `missed` as a metric; consistently > 0 means webhook delivery is broken.
7. Trace context: put `traceparent` into the payload or headers you store, so processing joins the original request trace (see `llm-observability`).

## Verification (required)

Against real Postgres. [verify/tests/webhook-ingestion.test.ts](../../verify/tests/webhook-ingestion.test.ts) covers:
- Signatures: valid passes; tampered body, wrong secret, stale timestamp, missing or malformed header, and wrong-length hex all fail.
- The same event delivered twice → 1 row, handler effect applied once, including when the duplicate arrives *after* processing.
- A handler that writes then throws → the write is rolled back; status `pending`, `attempts` 1, `next_attempt_at` in the future; not re-run before due; eventually `done`.
- After `maxAttempts` → `dead`, `onDead` fires, the DLQ view shows it; `replay` → processed successfully.
- 4 concurrent workers × 60 events → exactly 60 effects, all `done`.
- A row stuck in `processing` with an old `locked_at` is re-claimed. Unknown event type → acknowledged as `ignored`.
- Reconciliation ingests only missing events and reports the count.

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
