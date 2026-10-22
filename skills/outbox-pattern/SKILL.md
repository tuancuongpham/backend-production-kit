---
name: outbox-pattern
description: Publish domain events reliably alongside database writes (transactional outbox + relay + idempotent consumers) — the practical replacement for "exactly-once" event pipelines. Use whenever code writes to the DB and then publishes to Kafka/NATS/RabbitMQ/Redis/SQS or calls another service ("save order then send event", "dual write"), when the user asks for event sourcing, exactly-once, saga, CQRS, or async AI jobs off the request path, or mentions "mất event", "event bị gửi trùng", "xử lý bất đồng bộ".
---

# Transactional outbox → effectively-once

`db.save(order); broker.publish(event)` loses events when the process dies between the two lines, and duplicates them when the publish succeeds but the ack is lost. End-to-end exactly-once across a DB and a broker doesn't exist in practice. What you can build is **at-least-once delivery + idempotent consumers = effectively once**:

1. **Producer**: insert the event into an `outbox` table *in the same transaction* as the state change. The event exists if and only if the change committed.
2. **Relay**: a single active process reads unpublished rows in order, publishes them with `id` as the message id, then marks them published. A crash causes a re-publish, never a loss.
3. **Consumer**: records `(consumer, message_id)` in `processed_messages` *in the same transaction* as its side effects. Duplicates become no-ops.

This is also how to keep slow AI work off the request path. The request writes `order.placed` and returns. A consumer runs the LLM step and writes its result with the same dedup guarantee.

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Do they need event sourcing at all? | No: state tables + outbox | Full event sourcing (events as the source of truth, projections, snapshots) is a big commitment. Recommend it only for audit-heavy domains (ledgers) and say why. |
| Broker | What they already run; else NATS JetStream or a Postgres-only queue | JetStream dedups on `Nats-Msg-Id` within a window; Kafka orders per partition key (use `aggregate_id`). |
| Relay mechanism | Polling + `LISTEN/NOTIFY` wakeup | CDC (Debezium, logical replication) at high volume or when you can't touch app code. |
| Ordering scope | Per aggregate | Global ordering needs a single partition, and throughput collapses. |
| Retention of published rows | 7 days | Useful for debugging and replay; prune with `pruneOutbox`. It is one DELETE on purpose: in batches through an index it was measured 11× slower, with no shorter statement ([performance](../../docs/performance.md)). |

## Implementation steps

1. Migration: [references/outbox.sql](references/outbox.sql), which creates `outbox`, `processed_messages`, and an optional NOTIFY trigger.
2. Producer: call `enqueue(tx, …)` from [references/outbox.ts](references/outbox.ts) with the **business transaction's client**. Put `traceparent` and the tenant id in `headers`, and add a schema version to the payload.
3. Relay: run `createRelay({ pool, publish }).run({ signal })` in the relay process. It relays batch after batch while there is a backlog and polls every `idleMs` (default 1 s) when there isn't; for lower latency, also call `relayOnce()` from a `LISTEN outbox` handler. Each batch takes `pg_try_advisory_xact_lock`, so only one relay instance is active, which is what keeps ordering. It stops at the first failed publish so later messages don't overtake. That also means a message the broker always refuses (too large, a schema it rejects) holds back every message behind it: alert on the age of the oldest unpublished message, and on its `attempts`. `run()` refuses a NaN `idleMs`, which polled every millisecond. Copy `hooks.ts`, `pg-transaction.ts`, `pg-values.ts`, `with-timeout.ts` and `worker-loop.ts` along with `outbox.ts`: they are the kit's shared building blocks. `pg-values.ts` keeps a NUL in a payload from rolling back the business transaction.
   - `publishTimeoutMs` (default 10 s) fails a publish that never settles. Without it, one hung broker call keeps the relay's transaction and lock open forever: every instance skips, and the outbox stops with no error anywhere.
   - If the database connection dies mid-batch (failover, `idle_in_transaction_session_timeout`), the relay stops before its next publish once the client has noticed: the marks can't commit any more, so every further publish would only be sent again on the next run. A drop the client hasn't seen yet can't stop it; those messages go out again, and consumers dedup by id.
   - Published messages are marked with one `UPDATE … WHERE id = ANY($1)` per batch, not one per message. That gives 8× the relay throughput at batch 100 (26,600 vs 3,200 messages/s against an instant broker) with the same crash behaviour, because the marks only become durable at `COMMIT` either way. With a real broker, publish latency dominates: use its async or batched publish API before raising `batchSize`.
4. Consumers: wrap every handler in `consumeOnce(pool, 'consumer-name', msg.id, tx => …)`. A consumer whose side effects are outside this DB (email, HTTP) passes `msg.id` as the downstream idempotency key instead.
5. Metrics: export outbox lag (`now() - min(created_at) WHERE published_at IS NULL`), publish failures, duplicate rate at consumers. Alert on lag.

## Verification (required)

[verify/tests/skills/outbox-pattern.test.ts](../../verify/tests/skills/outbox-pattern.test.ts):
- Business transaction rolls back → no outbox row; commits → exactly one.
- Relay publishes once and marks; a second run publishes nothing.
- Broker fails on message 2 of 3 → only 1 published, 2 keeps `attempts`/`last_error`, 3 doesn't overtake; after recovery the order is 1, 2, 3.
- Publish succeeds but the relay "crashes" before marking → the broker receives a duplicate → the consumer reports `applied`, then `duplicate`, and the side effect happens once.
- Consumer throws → the dedup mark rolls back → a retry applies.
- Two relays at once → one backs off, nothing is published twice.
- `run()` drains a backlog of 25 in batches of 10, then picks up a message written later, until stopped; each is published once.
- A publish that never returns → `relayOnce` gives up after `publishTimeoutMs`, records the error on that message, and releases the lock, so the next run can proceed ([regressions/round-2.test.ts](../../verify/tests/regressions/round-2.test.ts)).
- Postgres goes away (through Toxiproxy) right after the first of 3 publishes → once the relay's connection has noticed, `relayOnce` rejects without publishing the other two; after recovery all 3 go out, and only the first was sent twice ([resilience-testing.test.ts](../../verify/tests/skills/resilience-testing.test.ts)). Before the fix, all 3 were sent twice.

In a staging environment, also kill the relay process mid-batch (`kill -9`) and confirm the lag recovers with no gaps at the consumer.

## Record the decision
ADR: why outbox over event sourcing or dual writes, broker choice, ordering scope, relay mechanism.

## Common mistakes
- `enqueue` with the pool instead of the transaction client. That is a dual write again.
- Several relays with `SKIP LOCKED` and no leader: throughput goes up, ordering is gone.
- Consumers that "check then act" without a unique constraint, so races double-apply.
- Publishing inside the business transaction ("just to be safe"): it holds locks during network I/O, and a publish followed by a rollback produces ghost events.
- Awaiting the broker with no timeout inside the relay's transaction: a single hung connection silently stops all event delivery.
