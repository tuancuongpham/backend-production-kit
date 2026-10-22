---
name: idempotency-keys
description: Make retried POST requests and AI-agent tool calls safe with Stripe-style Idempotency-Key handling in Postgres — the same key returns the first response instead of a second order, charge or email; a duplicate arriving mid-flight gets 409, a key reused for a different request gets 422, keys expire and are pruned. Use whenever the user builds create, checkout, payment, transfer or send endpoints, public or mobile APIs whose clients retry, agent tools that write or spend, or mentions idempotency, Idempotency-Key, double charge, duplicate orders, "bấm thanh toán 2 lần", "gửi trùng request", "chống trùng giao dịch", "retry an toàn".
---

# Idempotency keys: retries without double effects

Clients retry. A mobile app loses signal, a buyer double-clicks "Pay", a gateway retries a slow request, an AI agent
re-runs a tool call after a timeout. The server sees the same POST twice and, without help, creates two orders or
charges twice. The client can't prevent this alone, because it never knows whether the first attempt landed.

The fix is a contract. The client sends one random `Idempotency-Key` per operation and reuses it on every retry of
that operation. The server stores the key with the response, and answers retries from storage:

```
POST /orders   Idempotency-Key: 7f0c2a8e-…
  claim (scope, key) in Postgres
    new                       → run the handler; store status + body with its effect → 201
    finished, same request    → replay the stored response (Idempotent-Replayed: true)
    still running             → 409 + Retry-After, at once (no connection waits for the first)
    used for another request  → 422
  handler threw, or the process died → nothing stored: the same key can be retried
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Which endpoints | Every write with an effect someone pays for or sees: create, checkout, charge, transfer, send, and every agent tool that writes | GET, PUT and DELETE are idempotent by HTTP semantics if implemented that way. Check that they are. |
| Key required? | Required (400 without it) on money-moving routes and agent tools; optional elsewhere | An optional key protects nobody whose client doesn't send one. Your own apps and SDKs should always send one. |
| Where the effect lives | Same Postgres → `runIdempotent`. A payment provider, an email or another service → `runIdempotentExternal` | Charge plus insert: external, with the insert made idempotent. |
| Scope | Tenant + principal (user or API-key id) from authentication | One caller's key must never replay another caller's response. Anonymous routes: require a UUID and scope by route. |
| Retention | 24 h | Must outlive the client's retry window. Mobile apps queue requests offline for hours; agent queues retry for longer. |
| Concurrent duplicate | 409 + `Retry-After: 1` | As Stripe and the IETF draft do. Making duplicates wait for the first request holds one database connection per waiting duplicate (measured below). |
| What is stored | Status, body and chosen headers of definitive outcomes: 2xx and business 4xx ("card declined") | Thrown errors (5xx, timeouts) store nothing, so the client may retry. Keep bodies small: ids and status, not lists. |

## Implementation steps

1. **Table.** [references/idempotency.sql](references/idempotency.sql): the `(scope, key)` primary key, the request
   fingerprint, the status, the stored response and `expires_at`. Under `multitenant-postgres` RLS, the tenant lives in
   `scope` and every query filters by it; grant the app role access to this table.
2. **Parse and fingerprint**, in the route, before any work:
   - `parseIdempotencyKey(req.headers['idempotency-key'])` returns undefined when the header is absent and throws a 400
     for anything but 1–255 visible ASCII characters (a header sent twice arrives joined with ", " and fails too);
   - `requestFingerprint(method, originalUrl, parsedBody)` hashes the body with object keys sorted, so a client that
     re-serializes the same JSON still matches. Method and path are included, so reusing a key on another route is a
     422;
   - `scope` comes from the authenticated principal, never from the body.
3. **Run the effect** with [references/idempotency.ts](references/idempotency.ts):
   - **Effects in this database** → `runIdempotent(pool, req, async (tx) => …)`. The claim, the handler's writes (all
     through `tx`) and the stored response commit in **one transaction**. A thrown error or a crash leaves nothing
     behind, so a retry runs cleanly. It costs two statements per request: about half a millisecond here.
   - **External effects** → `runIdempotentExternal(pool, req, async ({ downstreamKey, signal }) => …)`.
     - The claim commits first, so duplicates see it, and no transaction stays open across the network call. The
       response is stored after it.
     - The handler must be safe to run twice. Pass `downstreamKey` as the provider's idempotency key (Stripe
       `idempotencyKey`, a payment gateway's request id, an outbox message id), and make its own writes idempotent
       (`INSERT … ON CONFLICT`).
     - If the process dies mid-call, the claim stays in progress. After `staleAfterSec` a retry of the *same*
       request takes it over and runs the handler again, and the downstream key turns that into a no-op at the
       provider.
     - Every claim carries a new `claim_token`: only its holder may store the response or release the key. A
       request whose claim was taken over can't release the new owner's claim when it finally fails, which would
       let a third retry run alongside the second.
     - Pass `signal` to the external call, so it can't outlive the claim.
   - To configure once (`ttlSec`, `staleAfterSec`), create `new IdempotencyKeys({ pool, ttlSec })` and call its
     `run`, `runExternal` and `prune`; the functions above are one-call forms of the same.
   - Copy `pg-transaction.ts` and `pg-values.ts` along with `idempotency.ts`: the kit's shared transaction helper, and the one that makes a stored response hold any text (a NUL echoed from the request would roll back the order and fail every retry the same way). Both are identical in
     every skill that has it.
   - Handlers **return** definitive outcomes, which are stored and replayed, and **throw** on transient failures,
     which store nothing.
4. **HTTP mapping.**
   - A replay sends the stored status, body and headers plus `Idempotent-Replayed: true`.
   - An `IdempotencyError` becomes `err.status` (400, 409 or 422), with `Retry-After: err.retryAfterSec` on 409.
   - Tell API clients: one UUID per operation, reused on every retry of it, never shared across operations.
5. **Agent tools.** Use the model's tool-call id as the key: it stays the same across retries of that call. Use the
   agent session's tenant and user as the scope. `agent-safe-db` covers the read side; this is the write side.
6. **Retention.** Run `pruneIdempotencyKeys(pool)` hourly. It deletes expired keys in batches through the
   `expires_at` index.
7. **Metrics.** Count replays, 409s and 422s per route. A rising replay rate means clients are timing out; 422s mean
   some client builds keys wrongly.

```ts
app.post('/orders', async (req, res) => {
  const key = parseIdempotencyKey(req.headers['idempotency-key']); // throws IdempotencyError(400)
  if (!key) return res.status(400).json({ error: 'Idempotency-Key header required' });
  const r = await runIdempotent(
    pool,
    { scope: `${req.auth.tenantId}:${req.auth.userId}`, key, fingerprint: requestFingerprint(req.method, req.originalUrl, req.body) },
    async (tx) => {
      const { rows } = await tx.query('INSERT INTO orders (customer_id, total) VALUES ($1, $2) RETURNING id', [req.auth.userId, req.body.total]);
      return { status: 201, body: { id: rows[0].id }, headers: { location: `/orders/${rows[0].id}` } };
    },
  );
  if (r.replayed) res.set('Idempotent-Replayed', 'true');
  res.set(r.headers ?? {}).status(r.status).json(r.body);
});
// Error handler: IdempotencyError → res.status(err.status); add Retry-After on 409.
```

## Verification (required)

Against real Postgres. [verify/tests/skills/idempotency-keys.test.ts](../../verify/tests/skills/idempotency-keys.test.ts) covers:
- Same key twice → one order. The retry gets the identical status, body and headers, marked as a replay.
- **20 concurrent requests with one key → the handler runs once.** The others get 409 without waiting for the first
  (300 ms) to finish, and a later retry replays.
- Same key with a different body, or on another route → 422, and nothing runs.
- A handler that throws → the order rolls back, no key remains, and the retry runs once.
- **The connection killed right after the order insert** (the app server dying) → no order, no key; the retry runs
  once. [connection-loss.test.ts](../../verify/tests/invariants/connection-loss.test.ts) also checks that this fails the request,
  not the process.
- Keys are scoped per caller. An expired key runs again. Pruning deletes 2,500 expired keys in batches and keeps live
  ones.
- External effects, against a fake provider that dedups like Stripe:
  - a duplicate mid-call gets 409, and the retry replays without calling the provider;
  - **a process that died after charging is recovered after `staleAfterSec` with no second charge**, and a different
    request can't take its claim over;
  - a failed call releases the key, and the retry sends the same downstream key;
  - a request whose stale claim was taken over fails later → the new owner's claim stays, and a third retry gets
    409 instead of charging again ([regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts)).
- Keys are parsed strictly and fingerprints are canonical.

How to write these tests so they prove something:
- Count the **business effect** (orders, charges at the fake provider), not rows in the keys table.
- Make the concurrent test real: a handler that sleeps while 20 requests arrive. Sequential "retries" never hit the
  race.
- Kill the connection mid-handler (`pg_terminate_backend`) to prove the effect and the key commit together.

## Record the decision
ADR: which routes require a key, the scope, retention versus the client's retry window, 409 versus waiting, which
effects are external and how each external call is made idempotent downstream.

## Common mistakes
- **Check, then insert**: `SELECT` the key, run the handler, `INSERT` the key at the end. Concurrent duplicates all
  pass the check. In the benchmark, 20 copies ran the handler 20 times, and 19 then failed on the primary key with a
  500 after doing the work ([performance](../../docs/performance.md)). With an email or a charge, all 20 would have
  happened.
- Letting duplicates wait for the first request (`INSERT … ON CONFLICT` with no lock): correct, but each waiting
  duplicate holds a connection for the first request's whole duration. Nineteen duplicates of a 200 ms request held
  about 4 s of connection time, against 0.13 s with an immediate 409. A retry storm then empties the pool.
- Storing the key in another transaction than a database effect: a crash in between loses the response of an effect
  that happened, or stores one for an effect that rolled back.
- Holding a transaction open across the provider call "for atomicity". The provider doesn't roll back with you, and
  the connection and its locks wait on the network.
- An external call without a downstream idempotency key: the client's retry after a timeout charges twice.
- Keys shared across callers: one customer's retry replays another customer's response.
- Fingerprinting raw body bytes: a client that re-serializes JSON on retry gets a spurious 422.
- Storing 5xx or timeout responses: the client can never complete that operation with its key.
- Expiring keys sooner than clients retry.
- Releasing or completing a claim by key alone. After a takeover, the old owner deletes or overwrites the new
  owner's claim; only the holder of the current claim token may.
