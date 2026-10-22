# Signals from the other skills

Each skill in this kit already exposes the number that says it is failing. Wire these up as SLOs (burn-rate
alerts) or plain alerts. Database signals need a SQL exporter (`postgres_exporter` custom queries, `sql_exporter`)
or a small job that writes them as metrics.

| Skill | Signal | How to read it | Alert |
|---|---|---|---|
| service-hardening | Availability and latency per route | OTel `http.server.request.duration` histogram (auto-instrumented) | SLO: 99.9% non-5xx; SLO: 99% under the latency threshold (a bucket ratio, not an average) |
| service-hardening | Load shed (fast 503s) | Count of 503s from the in-flight cap | Ticket when more than 1% of requests are shed for an hour: capacity |
| job-queue | How long due jobs wait | `SELECT oldest_wait_sec FROM job_queue_stats WHERE status = 'available'` | SLO: 99% of jobs start within 60 s; page past 5 min |
| job-queue, webhook-ingestion | New dead letters | `count(*)` from `job_dead_letters` / `webhook_dead_letters`, as an increase | Ticket on any increase; page for payment providers |
| webhook-ingestion | Missed deliveries found by reconciliation | `reconcile().missed` | Ticket when > 0 twice in a row: delivery is broken |
| outbox-pattern | Outbox lag | `SELECT extract(epoch FROM now() - min(created_at)) FROM outbox WHERE published_at IS NULL` | Page past 5 min: consumers are working on stale state |
| rate-limiting | Degraded decisions | Ratio of `source != 'redis'` | Ticket at 1% for 15 min; page if `fail-closed` blocks real traffic |
| cache-stampede | Origin load per key family, cache errors | Counters around `load` and `onError` | Ticket when the origin rate doubles after a deploy (a key format changed) |
| llm-gateway | Spend anomaly | The "today > 3× trailing average" query in `semantic-cache.sql` | Page the cost owner the same day |
| llm-gateway | Fallback rate, budget refusals | `llm_usage.fallback_from`, refused calls | Ticket when the fallback rate exceeds 5% for an hour (a provider is degrading) |
| sse-streaming | Time to first token | TTFT histogram per model | SLO: 95% under 2 s |
| idempotency-keys | 409 and 422 rates | Counters on the error responses | Ticket on a 422 spike: a client builds keys wrongly |
| data-retention-and-erasure | Erasure requests near their deadline | `SELECT count(*) FROM erasure_requests WHERE completed_at IS NULL AND due_at < now() + interval '3 days'` | Ticket at 3 days left, page at 1 day |
| zero-downtime-migrations | Queries waiting on locks | `pg_stat_activity` rows with `wait_event_type = 'Lock'` for more than 1 s | Page during deploys: a migration is queueing traffic |
| multitenant-postgres, all | Pool errors (connections lost) | `pool.on('error')` count | Ticket on a rising rate: failovers, timeouts |
