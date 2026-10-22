# Go-live checklist

Tick each item, or write down why it doesn't apply. Items marked 🧪 should have an automated test.

## Requests
- [ ] 🧪 Inbound: headers timeout, request timeout, keep-alive timeout > LB idle timeout
- [ ] 🧪 Body size limit on every endpoint that reads a body (413)
- [ ] 🧪 Load shedding: 503 + `Retry-After` beyond max in-flight
- [ ] 🧪 Client disconnect cancels downstream work (DB, HTTP, LLM)
- [ ] Every outbound call has a deadline; retries are bounded with jittered backoff and only for idempotent operations
- [ ] 🧪 Postgres pool: `connectionTimeoutMillis` (without it, a connect to a black-holed database waits forever) and a
  client-side `query_timeout`. A server-side `statement_timeout` limits server work, not a slow network
  ([`resilience-testing.test.ts`](../../../verify/tests/skills/resilience-testing.test.ts))
- [ ] Per-tenant / per-user rate limits (see `rate-limiting`)

## Lifecycle
- [ ] 🧪 SIGTERM → readiness 503 → drain → in-flight finish → hooks → exit, all within the platform grace period
- [ ] Process is PID 1 or behind an init (`tini`, `--init`), so signals arrive
- [ ] 🧪 `/livez` has no dependency checks; `/readyz` checks deps with timeouts
- [ ] Startup validates config and fails fast
- [ ] DB pool size × instances ≤ DB `max_connections` (minus headroom for migrations and admin)
- [ ] 🧪 A Postgres restart or failover doesn't crash the process. node-postgres emits `error` when the server ends a
  connection: `pool.on('error', log)` covers idle pooled clients, and every checked-out client needs a listener
  for as long as it is held (the kit's reference functions add one). With neither, one `pg_terminate_backend` or
  `idle_in_transaction_session_timeout` exits the process with every in-flight request
  ([`connection-loss.test.ts`](../../../verify/tests/invariants/connection-loss.test.ts))
- [ ] Retried writes are idempotent: `Idempotency-Key` on create/charge/send endpoints (see `idempotency-keys`)

## Observability
- [ ] Request id generated or propagated and present in every log line
- [ ] Structured logs with PII redaction (see `pii-redaction`)
- [ ] Traces cover HTTP → DB → external/LLM (see `llm-observability`)
- [ ] RED metrics per route (rate, errors, duration p50/p95/p99), plus in-flight and shed counts
- [ ] Alerts on error-rate and latency SLOs, not on CPU

## Resilience
- [ ] Load test at 2× peak: numbers recorded in a benchmark doc
- [ ] Rolling deploy under load: zero deploy-caused 5xx
- [ ] 🧪 Dependency failure drill: slow, black-hole, reset and stop the DB/Redis/LLM provider through Toxiproxy and
  assert the degradation each design promises (see `resilience-testing`)
- [ ] Redis clients with `enableOfflineQueue: false` connect before readiness turns green
- [ ] Runbook: how to roll back, how to replay dead letters, who is on call
