# Fault scenarios

For each dependency, inject each fault and check the behaviour the design promises. The **expected** column is the
assertion to write. If nobody can say what it should be, that is the finding.

| Dependency | Fault (Toxiproxy) | Expected behaviour | Typical gap |
|---|---|---|---|
| Postgres | `latency` 1 s on replies | Requests fail at the client's `query_timeout` (or the request deadline) | Only `statement_timeout` is set: the query is fast, the network isn't, and nothing fires |
| Postgres | `timeout` 0 (black hole) on new connections | `connectionTimeoutMillis` fails the checkout in ~0.5 s; the pool keeps serving other requests | No connect timeout: every new connection hangs, then the pool runs dry |
| Postgres | `reset_peer` mid-transaction | That request fails and its transaction rolls back; the process lives; the pool drops the dead client | No `error` listener on checked-out clients: the process crashes |
| Postgres | proxy down for 10 s (failover) | Requests fail fast, readiness goes red, everything recovers without a restart | Pool full of dead clients; readiness stays green |
| Postgres | proxy down mid-batch (outbox, jobs) | Nothing lost; the batch is redone after recovery; consumers dedup | Work published or charged twice without idempotency |
| Redis | `latency` above the client timeout | Rate limiter and cache fall back within their `timeoutMs` | Default ioredis options: commands queue for seconds |
| Redis | proxy down | Limiter runs its failure mode; cache serves from the origin and reports it | The cache's error takes the request down with it |
| Redis | down at startup | The app reports not-ready until connected | With `enableOfflineQueue: false`, the first requests fail into fallback modes |
| LLM provider | `latency` 30 s, or `reset_peer` | Fallback to the next provider within the per-attempt timeout; breaker opens | No per-attempt timeout: the whole chain waits |
| Broker | publish never returns | Relay gives up after `publishTimeoutMs`, releases its lock | Relay stalls forever holding the advisory lock |
| Any | `bandwidth` 10 KB/s | Large responses hit deadlines; small ones still pass | No deadline on streaming reads |

Run the slow ones (black holes, failovers) in a nightly job, and the fast ones on every pull request.
