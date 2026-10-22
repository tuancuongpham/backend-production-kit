---
name: resilience-testing
description: Prove that the app degrades the way its design says when a dependency is slow, black-holed, reset or down — Toxiproxy between the app and Postgres, Redis, brokers or LLM providers in docker-compose and CI, a small client to add latency, black holes, connection resets and outages from tests, a scenario catalog with the expected behaviour per fault, and the timeouts each fault exposes (client query timeouts, connect timeouts, offline queues). Use whenever the user asks what happens if the database or Redis is slow or down, adds timeouts, retries, fallbacks or circuit breakers, prepares for failovers, or mentions chaos engineering, fault injection, Toxiproxy, resilience, "DB chậm thì app treo", "Redis chết thì sao", "kiểm thử khi mất kết nối".
---

# Resilience testing with Toxiproxy

Every design says what happens when a dependency fails: "falls back to local limits", "times out after 2 s",
"nothing is lost". Almost none of it is tested, because a unit test can't make a TCP connection hang. Toxiproxy
can. It sits between the app and each dependency, and tests turn its faults on and off through an API: latency,
black holes, connection resets, bandwidth caps, outages.

It is the cheap version of a chaos platform: one container, plain integration tests, and a list of findings the
first time you run it.

```
app ──► toxiproxy:55440 ──► postgres:5432        test: proxy.add({ type: 'latency', attributes: { latency: 1000 } })
    └─► toxiproxy:63800 ──► redis:6379                 proxy.down() / proxy.up() / toxi.reset()
assert: fails fast · falls back · loses nothing · recovers without a restart
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Which dependencies | Every network dependency the request path touches: database, cache, broker, LLM and payment providers | External APIs can sit behind Toxiproxy too, pointed at a local stub. |
| Expected behaviour per fault | From each skill's design: [references/scenarios.md](references/scenarios.md) | Write the expectation before the test. A missing one is the finding. |
| Where it runs | Fast scenarios (latency, resets, outages) on every PR; slow ones (black holes, long failovers) nightly | The six kit scenarios take about 5 s. |
| Production chaos | Not until these pass in CI | Injecting faults in production without this baseline only finds what CI would have found. |

## Implementation steps

1. **Infrastructure.** Add Toxiproxy next to the dependencies
   ([references/docker-compose.toxiproxy.yml](references/docker-compose.toxiproxy.yml); in GitHub Actions, as a job
   service with the proxy ports published). Point the code under test at the proxy ports, not at the
   dependencies.
2. **Client.** `createToxiproxy(apiUrl)` from [references/toxiproxy.ts](references/toxiproxy.ts):
   - `proxy(name, listen, upstream)` once per dependency;
   - then `add`, `remove`, `with(toxic, fn)`, `down` and `up`;
   - `reset()` between tests.
3. **Write one test per row** of the scenario catalog that applies. Assert timing ("failed within 600 ms"),
   outcome ("fell back to the local bucket", "served from the origin") and recovery ("Redis again after it
   recovered").
4. **Fix what they find.** The usual list:
   - a client-side `query_timeout`;
   - `connectionTimeoutMillis`;
   - error listeners on pools and checked-out clients;
   - connecting before reporting ready;
   - deadlines on every outbound call;
   - idempotency where a retry repeats work.

## Verification (required)

[verify/tests/resilience-testing.test.ts](../../verify/tests/resilience-testing.test.ts) runs the kit's own
reference code through Toxiproxy:
- **Slow network (1 s latency).** A server-side `statement_timeout` of 300 ms never fires: the query is instant,
  and the reply waited the full second. A client-side `query_timeout` of 300 ms failed the call in under 600 ms.
- **Black-holed database.** A new connection without `connectionTimeoutMillis` was still waiting after 2 s; with
  500 ms, it failed in under 1 s.
- **Connection reset mid-transaction.** `withTenant` rejects, the process keeps running, and a fresh connection
  works.
- **Redis slower than the rate limiter's 50 ms timeout.** It fell back to the local bucket in under 150 ms, and
  returned to Redis once latency went away.
- **Redis down.** The cache served from the origin, called it once, and reported the outage.
- **Postgres gone mid-outbox-relay.** Nothing was lost. Once its connection noticed the drop, the relay stopped
  publishing, so only the message in flight went out twice. A drop the client hasn't seen yet can't stop it: those
  publishes go out again on the next run, and consumers dedup.

How to write these tests so they prove something:
- Connect before injecting a fault that should hit established connections, and inject it before connecting for
  faults that should hit new ones. These are different failures.
- Assert time bounds. "It eventually failed" is exactly the hang the test is there to catch.
- Wait for states, not durations. Toxiproxy's API can answer before the app's socket has seen the close, so before
  asserting what happens after a drop, wait until the client noticed it (pg's `end` event). The outbox test raced
  those two events and once failed on CI.

## Record the decision
ADR: dependencies covered, expected behaviour per fault, timeouts chosen (with the test that proves them), where
the suites run.

## Common mistakes
- Trusting `statement_timeout` to bound request latency. It limits server work, not a slow or partitioned network.
- No `connectionTimeoutMillis` on the pool. During a failover, every new connection waits forever.
- `enableOfflineQueue: false` (right for request paths) without connecting before serving: the first requests after
  a deploy all run in the failure mode.
- Testing failure by stopping the container. That is a clean refusal, the easiest fault. Black holes and resets
  are what break production.
- Fault tests that only assert "no crash", without the time bound or the recovery.
