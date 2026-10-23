---
name: job-queue
description: Run background jobs on Postgres reliably — enqueue in the same transaction as the business write, claim with SKIP LOCKED, leases with heartbeats so a crashed worker's jobs come back, retries with jittered backoff, dead letters with replay, unique jobs, delayed jobs, and recurring jobs that fire exactly once across instances. Use whenever the user sends emails or notifications after a request, moves LLM, embedding or export work off the request path, needs cron or scheduled jobs and reminders, retries flaky API calls, or mentions BullMQ, Sidekiq, Celery, pg-boss, graphile-worker, River, background job, job queue, "cron chạy trùng", "job bị mất", "hàng đợi", "tác vụ nền".
---

# Background jobs on Postgres

Every app grows background work: confirmation emails, LLM and embedding jobs, exports, retries of flaky APIs,
nightly reports. The failures repeat:
- jobs lost on restart (in-process queues, Redis lists without persistence);
- a job enqueued for a transaction that rolled back, or missing for one that committed;
- the same cron job firing once per instance;
- a crashed worker's job left "running" forever;
- retries hammering a dead provider in lockstep.

If the app already runs Postgres, the database can be the queue. The job row is written in the same transaction
as the business change, and row locks provide the guarantees.

```
request:  BEGIN; INSERT order; enqueue(tx, 'send-confirmation'); COMMIT   → the job exists iff the order does
worker:   claim (SKIP LOCKED, leased) → handler(job, { signal }) while heartbeats renew the lease → done
          throws    → scheduled again with backoff + jitter → … → dead after max_attempts → retryDead after the fix
          dies      → lease expires → maintain() rescues it → it runs again (at-least-once)
delayed:  'scheduled' until run_at → maintain() promotes it to 'available'
cron:     tick() on every instance → each fire enqueued exactly once
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| **Adopt or build** | Adopt a library when one fits the stack: pg-boss or graphile-worker (Node), River (Go), Oban (Elixir), Solid Queue (Rails), Procrastinate (Python) | They implement the same mechanics. Check the chosen one against the verification list below. Build from the reference when the queue must live in your schema or none fits. |
| Backend | The app's Postgres | Transactional enqueue for free. Move to a broker (SQS, RabbitMQ, Kafka) when sustained volume or other consumers need it, and keep the enqueue transactional with `outbox-pattern`. |
| Jobs or workflows? | Jobs: one unit of work each | Multi-step processes that must survive for days (sagas, waiting on a human approval, compensation on failure) belong in a workflow engine: Temporal, Inngest, Restate, DBOS. Chaining jobs by hand rebuilds one badly. |
| Delivery | At-least-once | A crash after the work and before the "done" mark always means a second run. Handlers key their effects by `job.id`: a unique constraint, or `downstreamKey` from `idempotency-keys`. |
| Lease and timeout | 60 s lease renewed every 20 s; 15 min job timeout | The lease only has to survive a missed heartbeat or two. The timeout catches hung handlers. |
| Retries | 8 attempts, exponential backoff from 1 s with equal jitter, 1 h cap, then dead | Set `maxAttempts` per job. Ask who gets alerted on dead letters. |
| Priorities and isolation | Priority within a queue; a separate queue and worker for work that must not wait behind other work | A priority reorders the queue but can't free a loop stuck on a slow job; a separate worker can. |
| Recurring jobs | `createScheduler` with `every(ms)`, or a cron-expression parser as `next` | Fires missed while down collapse into one run. A fire is dropped while the previous run is still queued or running. |
| Retention | Finished jobs 7 days; dead jobs until a human handles them | |

## Implementation steps

1. **Tables.** Add [references/jobs.sql](references/jobs.sql) as a migration.
   - A job moves `scheduled → available → running → done | dead`.
   - Delayed jobs and retries wait as `scheduled`, so the claim index holds only due jobs, in claim order. A claim
     or an idle poll then costs the same next to 1 or 1,000,000 finished or delayed jobs (measured below).
   - The partial unique index on `(queue, dedup_key)` implements unique jobs.
   - `job_dead_letters` and `job_queue_stats` are the views for dashboards.
2. **Enqueue inside the business transaction.** Call `enqueue(tx, { kind, payload, priority, runAt, maxAttempts,
   dedupKey })` from [references/jobs.ts](references/jobs.ts) with the transaction's client, never a separate
   pool query. Put ids in the payload, not whole objects that will be stale by the time the job runs.
   `enqueue` refuses an invalid `runAt` (a reminder time parsed from user input), a fractional `priority` and a
   `maxAttempts` below 1 with a `RangeError`: answer it with 400. So does a priority outside -32768 to 32767 (the
   column is a smallint) and a `maxAttempts` beyond an int.
3. **Handlers.** `createWorker({ pool, queue, handlers: { 'send-email': async (job, { signal }) => … } })`:
   - **safe to run twice**: key effects by `job.id`. A job runs again after a crash, a timeout or a lost lease;
   - pass `signal` to fetch, SDK and DB calls. It aborts at the job timeout, or when the lease was lost and another
     worker owns the job. A handler that ignores it is still abandoned at the timeout;
   - **throw** to retry with backoff. Reaching `max_attempts` makes the job dead and calls `onDead`;
   - a job of an unknown kind fails and retries, so a consumer deployed after its producer still gets it.
4. **Run the worker.** Call `worker.run({ loops, signal })` in the worker process.
   - It runs independent claim → run loops, as `webhook-ingestion` measured, plus a maintenance loop.
   - The maintenance loop rescues jobs whose lease expired and promotes due delayed jobs, about once a second, on
     every instance (SKIP LOCKED makes that safe).
   - A delayed job starts within about `maintainEveryMs + idleMs` of its `run_at`.
   - On SIGTERM, abort the signal and `await` the promise in the shutdown hook (`service-hardening`). Running jobs
     finish; jobs claimed but not started go back to the queue at once (`released`), their attempt not spent.
   - Leave `batchSize` at 1 unless jobs are tiny. With a batch, one heartbeat renews the lease of every job the
     batch holds, the waiting ones too, so a job queued behind a slow one can't expire and burn an attempt unrun.
   - `createWorker` and `run()` refuse NaN settings with a `RangeError`. `loops: Number(process.env.LOOPS)` with the
     variable unset is NaN, which used to start no loop at all; a NaN `idleMs` polled every millisecond, and a NaN
     retry delay failed every retry and the rescue of expired leases with it.
   - Copy `hooks.ts`, `pg-transaction.ts`, `pg-values.ts` and `worker-loop.ts` along with `jobs.ts`: they are the kit's shared building blocks,
     identical in every skill that has them.
5. **Recurring jobs.** Call `createScheduler({ pool, schedules: [{ name, kind, next: every(3_600_000) }] }).tick()`
   every few seconds from every instance.
   - Each due fire is enqueued exactly once: the schedule row is locked and moved forward in the transaction that
     enqueues the run.
   - For cron expressions, pass a parser's "next occurrence after" as `next`.
   - A schedule whose `next()` throws, or gives no valid date after the one it was given (an impossible expression
     such as February 31), doesn't fire, and the others still do. Pass `onError(err, scheduleName)` to log it; it is
     reported on every tick until fixed. Without `onError`, `tick()` rejects with an `AggregateError` once the others
     are enqueued.
   - Never `setInterval` a job in each app instance.
6. **Operations.**
   - Wire `retryDead()` into an admin command for after a fix ships.
   - Run `pruneJobs()` daily.
   - Alert on `job_queue_stats.oldest_wait_sec` for `available`: how long due work has waited. That is the queue's
     SLO, not its depth.

## Verification (required)

Against real Postgres. [verify/tests/skills/job-queue.test.ts](../../verify/tests/skills/job-queue.test.ts) covers:
- Enqueue inside a transaction that rolls back → no job; one that commits → exactly one.
- Due jobs run by priority, then oldest first. **A delayed job never runs early**, and runs once promoted.
- A failing job retries (with a real base delay, the retry lands 30–60 s out), dies after `max_attempts`, calls
  `onDead`, and `retryDead` brings it back once fixed.
- **A worker that dies after claiming**: the job comes back when its lease expires and runs exactly once more.
- **A worker frozen past its lease** (a GC pause, a sleeping laptop) loses the job. It runs elsewhere, and the late
  finisher's result is discarded (`'lost'`), not written over the new run.
- Heartbeats keep a 1.5 s job leased on a 0.6 s lease: maintenance never rescues it while it runs.
- A handler that ignores its abort signal is still abandoned at the timeout and retried.
- 10 concurrent enqueues with one dedup key → one job; the key is free again once that job has run.
- **Three scheduler instances ticking 30 times at once → each fire enqueued exactly once.** A fire while the previous
  run is queued is dropped. Three days of missed fires become one run.
- `run()` drains with four loops in parallel, including delayed jobs, and stopping leaves nothing `running`.
- A batch of 3 slow jobs on a 1 s lease, with another instance rescuing expired leases every 100 ms → all 3 run,
  none dies unrun. Stopping mid-batch waits for the running job only and hands the other 2 back with
  `attempts` 0 ([regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts)).
- `pruneJobs` deletes old finished jobs in batches and keeps dead and recent ones; `job_queue_stats` reports depth
  and the oldest wait.
- [regressions/round-6.test.ts](../../verify/tests/regressions/round-6.test.ts): one schedule returning an Invalid
  Date and another whose `next()` throws are reported while the third still fires; NaN worker settings and a
  priority outside smallint are `RangeError`s.
- [regressions/round-7.test.ts](../../verify/tests/regressions/round-7.test.ts): a `timeoutMs` Node can't schedule
  (past about 24.8 days, which timed every job out at once) and `pruneJobs` with `batchSize: 0` (a loop that never
  ended) are refused; an idle pause past that limit, which polled every millisecond, is refused by the worker loop.

How to write these tests so they prove something:
- Simulate a dead worker by claiming without ever heartbeating, and a frozen one by expiring a live worker's lease.
  Then assert on handler runs, not on rows.
- Use the database clock for delays (`SELECT now()`), not the test process's.
- Run the cron test with several scheduler instances ticking concurrently. One instance proves nothing.

## Record the decision
ADR: library or own tables, queue layout and isolation, retry policy per kind, lease and timeout, schedule list,
dead-letter alert owner.

## Common mistakes
- **Enqueueing outside the business transaction**: after the commit, a crash loses the job; before it, a rollback
  leaves a job for an order that doesn't exist.
- **Claiming from one table indexed on `run_at`.** The claim filters history it can't skip. With 1,000,000 finished
  jobs, every claim and every idle poll took 73 ms (a sequential scan), from every loop, every second
  ([performance](../../docs/performance.md)).
- **One `pending` state for due and delayed jobs.** The claim walks past every delayed job at a better priority: 3.4 ms
  per poll with 100,000 reminders scheduled, against 0.3 ms when they wait as `scheduled`.
- Running a cron job with `setInterval` in every instance: N instances, N runs.
- Holding a transaction open while the job runs: a slow API call holds locks and a connection, and
  `idle_in_transaction_session_timeout` kills it.
- A claim with no lease: a crashed worker's job stays `running` forever. Or a fixed timeout with no heartbeat: every
  long job is "rescued" and runs twice.
- Retrying at once, or at fixed intervals: every failed job hits the recovering provider at the same moment.
- Completing a job without checking the lease: a worker that lost the job overwrites the newer run's outcome.
- Heartbeating only the running job of a batch: the ones queued behind it expire, get rescued, and can go dead after
  `max_attempts` without ever having run.
- Racing a handler against a timeout without catching the losing promise: its late rejection crashes Node.
- No retention: the table grows forever. With the wrong indexes, every claim slows down with it.
- **Trusting a run time built from user input.** `new Date('31/12/2026 09:00')` is an Invalid Date, and Postgres
  answers with a cryptic syntax error. `enqueue` refuses it, a fractional priority and a non-positive `maxAttempts`
  with a `RangeError` that says which.
- **An async `onDead` alert.** If it rejects while the alert service is down, a bare call leaves an unhandled
  rejection, which ends the process. Hooks go through `callHook`.
- **All schedules in one all-or-nothing step.** One `next()` returning an Invalid Date failed the transaction that
  enqueues every due fire, and the registration of every schedule: one bad cron expression stopped all recurring
  jobs. Each schedule's own code is checked on its own.
