# Changelog

## 0.6.0 — 2026-10-23

### Fixed — latent bugs, round 4: real input
This round fed the skills what users, payment providers and models actually send: Vietnamese text in every form,
a NUL from a `%00`, half an emoji left by `slice(0, n)`, links edited by hand, made-up ids, days that don't exist.
It also drove the skills end to end over real HTTP (`verify/tests/journeys/`) and with generated input
(`verify/tests/properties/`). On 0.5.0, 25 of the 26 tests in `regressions/round-4.test.ts` fail (the 26th guards
against over-redaction), as do 7 of the 37 journey steps and 9 of the 23 properties that run on it. All pass now.
- Storage, in `webhook-ingestion`, `outbox-pattern`, `job-queue`, `idempotency-keys`, `llm-tool-safety`,
  `multitenant-postgres`, `llm-gateway` and `data-retention-and-erasure`:
  - one NUL anywhere in a payload, a note, a search query or a model's arguments failed the whole statement
    (22021, 22P05). The provider retried the webhook forever, and an order rolled back because of its note.
  - Half of an emoji did the same to jsonb (22P02). In `llm-tool-safety` it was worse: a write tool's result cut
    mid-emoji failed to store *after* the tool ran, so the agent's retry ran the refund a second time.
  - The new kernel file `pg-values.ts` (`pgText`, `pgJson`) stores both as U+FFFD at every storage boundary.
- `llm-tool-safety`:
  - a pattern written without `^…$` accepted `o-1'; DROP TABLE refunds; --` as an order id. Patterns now match
    the whole value, and `schemas()` states them anchored.
  - An approval id the model made up, or one edited in a URL, was a database error (22P02) instead of an unknown
    approval.
  - `decide()` took any string as the decision: `approve` was a 500, and `used` marked an approval used without
    spending it.
  - A tool-call id holding a NUL threw out of `call()`.
- `agent-safe-db`: a string parameter holding a NUL reached Postgres, and so did a date that doesn't exist. Those
  are `2026-02-31`, which `Date.parse` turns into March 3, and `0000-01-01`. Both are `ToolInputError`s now, which
  the model can correct.
- `sse-streaming`:
  - a bare CR is a line break to the browser, so `hello\rid: 999` in a message set the id the browser sends back
    on reconnect. Data is split on CR, LF and CRLF, and an id or event name holding a line break is refused.
  - Closing a tab mid-answer made `streamTokens` rethrow the SDK's `AbortError`, so every closed tab was logged as
    a failed request.
  - A model failing partway dropped the connection. The stream now ends with a `failed` event, and the error is
    still rethrown for the app to log.
- `service-hardening`:
  - after a clean shutdown, a timer kept the process alive for the whole `shutdownGraceMs` (20 s).
  - An open event stream made every deploy wait out the grace period and end forced. See `ctx.shuttingDown`
    below: a deploy with a live feed now takes 95 ms in the journey test instead of 5 s.
- `pii-redaction`. These were missed:
  - phone numbers written `(+84) 901 234 567` or `84 901 234 567`;
  - any number grouped in pairs, such as `09 01 23 45 67`: the pre-check wanted three digits in a row;
  - CMND numbers, and CCCD numbers with spaces, after their label;
  - emails with Vietnamese letters;
  - credentials in connection strings;
  - OAuth tokens and signatures in query strings;
  - `DB_PASSWORD=…` in env dumps and `"password": "…"` in a raw JSON body;
  - GitHub, AWS, Google and Slack tokens.

  Logging also threw on an object with a throwing getter (an ORM entity's lazy relation), on a proxy, and on an
  error with a non-string message. Errors now keep their `code`, `cause` and a redacted `detail` (where Postgres
  puts the duplicated email).
- `cache-stampede`:
  - `tenantKey('org:1', 'dashboard')` and `tenantKey('org', '1:dashboard')` were the same key. Parts are now
    percent-encoded.
  - A part holding half an emoji threw `URIError`.
- `slo-alerting`: three definitions loaded fine and could never alert. All three are now refused:
  - an error ratio without `{{window}}` (five identical rules);
  - `99.9` instead of `0.999`;
  - an objective under 0.931, whose 14.4× page would need more than 100% errors.
- `rag-evals`: a pull request that changed k compared recall@10 with the baseline's recall@5, and passed the
  gate. Runs with different k now fail it, and `evaluateRetriever` refuses a k below 1.
- `llm-gateway`: the cosine similarity of two small vectors underflowed to `Infinity`.

### Fixed — latent bugs, round 5: a second look
Round 5 had three parts:
- round 4's code read again, as a reviewer would;
- a type-aware linter over the whole repository, for the first time;
- a measurement of which code no test reached.

Its 21 hypotheses (`verify/tests/regressions/round-5.test.ts`) all failed before their fixes and pass now. The
linter found one more bug, in the cache's background refresh, and the coverage report showed where tests were
missing.
- `llm-tool-safety`:
  - once a write tool ran, a failure to record its result released the call, so the agent's retry ran the tool
    again: a second refund. That happened when the result held a BigInt (what ORMs return for bigint columns), when
    it pointed back at itself, or when the session couldn't be marked untrusted. Now the call stays claimed and
    answers `error`. A tool that failed is still released, so its retry runs.
  - A pattern written with the `m` flag matched line by line, so `o-1\nDROP TABLE refunds` passed on its first line.
  - A tool-call id longer than an index entry holds (about 2.7 KB) was a database error. Long ids are stored as
    their hash.
  - `schemas()` showed the model `^a|b$` as it was, which anchors each side only.
- Storage (`pg-values.ts`): a BigInt anywhere in a stored value threw, in an idempotency response, a job payload or
  an outbox event. In `idempotency-keys` it rolled back the order and failed every retry the same way. BigInts are
  now stored as decimal strings.
- Hooks: in eight skills, a hook the app passes in changed the outcome of the work it watched, when it threw or
  returned a promise that rejected:
  - `cache-stampede`: an `onError` that threw during a background refresh became an unhandled rejection, which ends
    the process;
  - `agent-safe-db`: an `onError` that threw for an idle connection the server ended became an uncaught exception,
    the very crash that listener exists to prevent;
  - worker loops (`webhook-ingestion`, `job-queue`, `outbox-pattern`): an `onError` that threw stopped the loop;
  - `webhook-ingestion` and `job-queue`: an `onDead` that threw made the batch reject, and an async one that rejected
    (Slack down) ended the process;
  - `sse-streaming`: a subscriber that threw kept the event from the others and failed the publisher, and an
    `onOverflow` that threw kept the stalled client connected;
  - `rate-limiting`: an `onRedisError` that threw failed the request, where the failure mode should have decided;
  - `llm-gateway`: an `onUsageError` that threw failed a request whose answer was already paid for.

  Every skill now calls its hooks through the new kernel file `hooks.ts` (`callHook`).
- `webhook-ingestion`: a valid signature with anything appended (`…0`, `…z`) still verified, because
  `Buffer.from(s, 'hex')` stops at the first character that isn't hex.
- `zero-downtime-migrations`:
  - a backfill could not be stopped. Run in a job that lost its lease, it kept writing beside the run that
    replaced it. `backfill()` now takes a `signal`.
  - The linter split a function body in `$fn1$` quotes, or an `E'it\'s; …'` string, at its semicolons, and flagged
    statements that weren't there.
- `job-queue`: an Invalid Date as `runAt` (a reminder time typed by a user), a fractional priority or
  `maxAttempts: 0` reached Postgres as a cryptic error. `enqueue` now refuses them with a `RangeError` that names the
  field.
- `multitenant-postgres`: `hybridSearch` passed `limit` and `candidates` straight to Postgres. From a query string,
  `-1` was a database error, and `candidates=1000000` a scan of the tenant's whole index. It now takes 1 to 100
  results and 1 to 1,000 candidates.
- `pii-redaction` and `llm-observability`: truncating a long log line or trace attribute could cut an emoji in two,
  leaving invalid text for whatever reads it next.

### Fixed — latent bugs, round 6: configuration, accounting, isolation
Round 6 looked at the numbers that arrive from configuration and from other systems, and at failures that spread to
the work beside them. Its 29 hypotheses (`verify/tests/regressions/round-6.test.ts`) all failed before their fixes
and pass now.
- A setting read from an unset environment variable is NaN, and NaN compares false with everything: in 14 skills a
  limit stopped limiting without an error. Every component now refuses NaN, negative values and a percentage where a
  ratio belongs with a `RangeError` before it starts:
  - `service-hardening`: `maxInFlight: NaN` shed nothing, and a NaN grace period cut every in-flight request when a
    deploy began;
  - `rate-limiting`: a NaN `timeoutMs` failed every Redis call at once, so `'open'` allowed everything;
  - `cache-stampede`: a NaN `timeoutMs`, `staleSec`, `jitter`, `lockMs` or `waitMs` each switched the cache off;
  - `llm-gateway`: a NaN timeout failed every provider and opened their breakers, and a `semanticThreshold` of 95
    (meant as 95%) never matched;
  - worker loops (`job-queue`, `webhook-ingestion`, `outbox-pattern`): `loops: NaN` started no loop at all, `idleMs:
    NaN` polled every millisecond, and a NaN retry delay failed every retry, in `job-queue` the rescue of expired
    leases with it;
  - `webhook-ingestion`: a NaN `toleranceSec` accepted a signature captured a year ago;
  - `sse-streaming`: a NaN heartbeat pinged every millisecond, and a NaN `maxBufferedBytes` or `maxQueue` never
    dropped a stalled client;
  - `zero-downtime-migrations`: NaN `attempts` and `retries` retried forever, and `batchSize: 0` "finished" a
    backfill that did nothing;
  - `agent-safe-db`, `data-retention-and-erasure`, `pii-redaction`, `rag-evals`: row caps, pool sizes, deadlines,
    the per-line work bound, and gate thresholds (a NaN threshold passed every regression);
  - `job-queue`: a priority outside smallint, or a `maxAttempts` beyond an int, was a database error.
- `llm-gateway`:
  - a monthly limit of NaN (a plan missing from the table) let every reservation through: NaN compares false in
    JavaScript and above every amount in Postgres `numeric`. The call is now refused.
  - An answer without token counts, as some SDKs return streamed answers, threw after the answer was paid for. With
    one count missing, the call was priced at NaN: in Postgres `spent_usd` became NaN and refused every later call of
    that tenant for the month. The reserved estimate is booked instead, and reported to `onError(err, 'usage')`.
  - A semantic cache hit returned the question another user had asked, name and order number included.
- `pii-redaction`: secrets under the names apps give them reached the logs in clear: `clientSecret`, `newPassword`,
  `passwordHash`, `idToken`, `x-auth-token`, `proxy-authorization`, `aws_secret_access_key`. Keys now match by how
  they end; `inputTokens`, `max_tokens`, `cacheKey` and `publicKey` keep their values. An object with `toJSON` (a
  `URL` holding `user:password`) was logged as `{}`; it is redacted as the logger prints it.
- `job-queue`: one schedule whose `next()` returned an Invalid Date (an impossible cron expression) or threw stopped
  every recurring job, at registration and on every tick. Each schedule is now checked on its own, and the failures
  go to the new `onError` option.
- `data-retention-and-erasure`: an external store that never answered hung the user's deletion request, and every
  request claimed beside it. Each store call now gets `storeTimeoutMs` (default 30 s) and an abort signal.
- `agent-safe-db`: an async audit that rejected was an unhandled rejection, which ends the process. The audit is
  awaited, and a call it can't record fails.
- `llm-tool-safety`: an approved call whose run failed (the payment API answered 503) couldn't be retried with its
  approval, "already used", so a human had to approve the same refund again. The approval is given back with the
  claim.
- `service-hardening`:
  - during the drain delay, requests the load balancer still sent got a 503: the error the delay exists to avoid.
    They are served now, with `Connection: close`.
  - `listen()` on a taken port never settled, and its unhandled `'error'` event crashed the process. It rejects with
    `EADDRINUSE`.
- `cache-stampede`: a fill or a background refresh that read the old row before a change wrote it back after the
  change's `invalidate()`, for a whole TTL. Writes are compare-and-set against what the writer saw, and `invalidate`
  leaves a tombstone.
- `zero-downtime-migrations`:
  - an unnamed `CREATE INDEX CONCURRENTLY` that failed left its INVALID index behind, one more on every retry;
  - a quoted identifier holding a `;` split its statement, and the linter missed what followed. `TRUNCATE` is now a
    warning.
- `slo-alerting`: two SLOs with the same name produced a rule file Prometheus refuses whole, every other alert with
  it.
- `sse-streaming`: an event without data threw a `TypeError`.

### Changed
- `service-hardening`:
  - `RequestContext.shuttingDown`, an `AbortSignal` that fires once a shutdown stops taking requests, after the
    drain delay. Long-lived responses end on it, so their clients reconnect to an instance that stays. Ending
    earlier would send the reconnect back to this instance, still draining, only to be ended again.
  - During the drain delay, requests are served with `Connection: close` instead of answered 503.
- `cache-stampede`: `invalidate()` leaves a tombstone for `lockMs` instead of deleting the key, and fills and
  refreshes write through a compare-and-set script (one key, Redis Cluster safe).
- `job-queue`: `createScheduler({ pool, schedules, onError })`. Without `onError`, `tick()` rejects with an
  `AggregateError` naming the failed schedules, after enqueuing the others.
- `data-retention-and-erasure`: `ExternalStore.erase(subjectId, signal)` and `storeTimeoutMs`; the skill now
  vendors `with-timeout.ts`.
- `agent-safe-db`: `audit` may return a promise, and is awaited. One round trip fewer per tool call.
- `rag-evals`: `evaluateRetriever(golden, retrieve, k, { concurrency })` and `runJudge(cases, judge, { concurrency
  })`, 4 calls at a time by default, results in input order (`mapInOrder` is exported).
- `sse-streaming`:
  - `openSse(req, res, { closeOn })` ends a stream cleanly when the signal fires; pass it `ctx.shuttingDown`.
  - `formatEvent()` is exported for frameworks that write the response themselves.
  - Clients close their EventSource on `failed` as they do on `done`.
- New kernel files `shared/pg-values.ts` (vendored into eight skills) and `shared/hooks.ts` (into nine). Hooks are
  typed to return `unknown`, so an async hook is fine: its rejection is dropped like a throw.
- `zero-downtime-migrations`: `backfill({ signal })` stops after the current batch, and the error carries `lastId`.
  A job passes its `ctx.signal`.
- `llm-tool-safety`: a write whose result can't be recorded answers `error`, "the tool ran, but its result could not
  be recorded". It stays claimed until `staleRunSec`, so the retry gets "still running", not a second run.
- `tsconfig.json` type-checks the tests and benchmarks too. A test reading `ctx.shutdown`, which doesn't exist,
  passed `undefined` along and still ran.
- To upgrade from 0.5.0:
  - no SQL changes. Copy `pg-values.ts` with the skills that import it.
  - `tenantKey` output changed for ids with characters outside `A-Za-z0-9-_.!~*'()`: a one-time miss for those
    keys.
  - The redactor has new placeholders (`[URL_CREDENTIALS]`, `[SECRET]`). Update any alert or dashboard that
    matches on them.
  - `ToolGuard#decide` throws a `TypeError` for a decision other than `approved` or `denied`. Check the decision in
    the route and answer 400.
  - `prometheusRules` refuses objectives below 0.931, and `compareReports` fails two runs with a different `k`.
    Both may stop a CI job that passed before; neither ever measured what it seemed to.
  - A token stream that fails partway ends with `failed`. Close the EventSource on it, as on `done`.
  - Throwing from `backfill`'s `onBatch` no longer stops it: pass `signal`. A hook throwing anywhere else no longer
    stops anything either.
  - `hybridSearch` throws a `RangeError` for a `limit` outside 1 to 100 or `candidates` outside 1 to 1,000, and
    `enqueue` for an invalid `runAt`, `priority` or `maxAttempts`. Answer them with 400.
  - BigInts in stored JSON (responses, payloads, tool results) come back as strings.
  - Options that are NaN, negative or out of range throw a `RangeError` when a component is created. Check every
    setting read from the environment: one that silently did nothing now stops the start.
  - The redactor redacts more keys: any name ending in a secret word (`clientSecret`, `idToken`, `x-auth-token`),
    and any with "passw" in it, timestamps such as `passwordUpdatedAt` included. Objects with `toJSON` are logged as
    their JSON.
  - `llm-gateway`: a limit or an estimate that isn't a number of dollars refuses the call; a result no longer
    carries `question`.
  - `data-retention-and-erasure`: copy `with-timeout.ts`. Stores get a second argument, the signal, and count as
    pending after 30 s.
  - `rag-evals`: retrievers and judges are called 4 at a time. Pass `{ concurrency: 1 }` to one that can't take
    concurrent calls.
  - `service-hardening`: a deploy no longer answers 503 during the drain delay; a test asserting that needs updating.

### Performance
- `agent-safe-db`: a tool call takes 3 round trips instead of 4, 15% faster end to end (p50 0.597 → 0.508 ms,
  [details](docs/performance.md#an-agents-database-tool-call--agent-safe-db)).
- `rag-evals`: 198 queries behind an 80 ms embedding call took 16.6 s one at a time; 4.2 s at the default
  concurrency of 4, 2.1 s at 8, with the same metrics.
- Measured and kept: `pruneOutbox` stays one `DELETE` (batches through an index were 11× slower, with no shorter
  statement), and the redactor keeps its per-detector hints (one union pre-check was 2.5× faster on lines without
  PII but up to 24% slower on typical lines).
- The redactor checks more formats, measured against 0.5.0 on the same machine
  ([details](docs/performance.md#pii-redaction-engine--pii-redaction)):

  | Workload | Change |
  |---|---|
  | typical log lines | 11% slower |
  | lines without PII | 20% slower |
  | PII-heavy lines | 9% faster |
  | a 50 KB line (0.1 ms), a structured record (140,000/s) | the same |

  Merging the detectors of one kind and running a shared pre-check once per line halved the first version's cost.

### Tooling
- Tests are organized by kind in `verify/tests/`; [verify/README.md](verify/README.md) says what each folder proves and
  when to add a test there:

  | Folder | Holds |
  |---|---|
  | `skills/` | one file per skill |
  | `kernel/` | the shared building blocks |
  | `journeys/` | end-to-end runs over HTTP |
  | `properties/` | generated-input tests |
  | `regressions/` | `round-N`, one file per review round |
  | `invariants/` | rules that cross skills |
  | `support/`, `fixtures/` | helpers and inputs |

  The old `helpers.ts` is now `support/infra.ts`, `wait.ts` and `vectors.ts`.
- ESLint with type-aware rules for bug classes, not style (`npm run lint`): a promise nobody awaits, a `return`
  inside `try` that skips its `catch`, a switch that misses a case, a thrown non-error. It found the cache's
  unhandled rejection.
- `npm run coverage` runs every test with coverage of the reference code and the kernel, and fails below 98% of
  lines, 90% of branches or 95% of functions. The kernel is measured once, in `shared/`, not again in every skill's
  copy. Now: 99.5% of lines, 93.0% of branches, 96.4% of functions.
- `npm run check` runs validate, typecheck and lint. `npm run test:<kind>` runs one folder of tests.
- CI runs a fast `check` job without services before `verify`, and the release job runs the same checks. The Node
  version comes from `.nvmrc`.
- `.editorconfig`, and a `.gitattributes` that stores and checks out text with LF on every platform.
- `sync:shared` and `validate` share one rule for which kernel files a skill needs (`scripts/lib/kernel.mjs`). That
  includes the files a kernel file imports itself: `worker-loop.ts` imports `hooks.ts`.
- `validate` also checks that each SKILL.md names every kernel file its skill needs, because an agent copies what
  the guide tells it to. The check found one gap at once: `multitenant-postgres` never said to copy
  `pg-transaction.ts`, which `tenant-db.ts` imports, so the code an agent produced from it didn't load.

### Tests
- Two more journeys:
  - two shops sharing the platform: search, an edited id, no tenant at all, odd limits, and both shops at once over
    a pool of two connections. They run as the app role; with a superuser pool, 4 of the 7 steps fail.
  - A customer's data rights: an export, a deletion tapped twice, a cached profile, a search index that is down.
- `verify/tests/kernel/` tests every shared building block.
- Tests for code no test reached:
  - `invalidate()`, and cache entries this cache didn't write;
  - `pruneOutbox`;
  - a client leaving mid-upload, `deadline()`, and the signal handlers;
  - the retry of a failed write;
  - an embedding provider that is down, and the ANN semantic cache;
  - a job whose lease is lost while it runs;
  - the linter's remaining rules, unsafe inventories, and a failed retrieval span.
- `verify/tests/regressions/round-6.test.ts`: the 29 hypotheses of round 6. The checkout journey and the drain test
  now expect a request during the drain delay to be served, with `Connection: close`.
- New benchmarks: `bench/compare/agent-db.ts`, `eval-concurrency.ts` and `outbox-prune.ts`.
- 436 tests in all, up from 334.
- `verify/tests/journeys/` drives the skills end to end over real HTTP, wired the way an application wires them,
  with what people and systems do:
  - checkout: a retry after a lost answer, a double tap, a tab closed mid-payment, a deploy mid-payment, a bot;
  - payment webhooks: duplicates, ten parallel deliveries, forged and captured requests, out-of-order events, a
    dead letter replayed after the fix, a delivery the provider never made;
  - the assistant's stream: a closed tab, a failing model, a reconnect with `Last-Event-ID`, a deploy;
  - agent approvals: an injected instruction, made-up ids, edited links, four eyes, another shop's supervisor.
- `verify/tests/properties/` holds property tests with fast-check. Each property runs a few hundred generated
  inputs; a deterministic seed keeps CI repeatable, and `KIT_FC_SEED=random` explores further. They show:
  - personal data in any grouping never survives redaction;
  - whatever a model sends is accepted only if the database accepts it too;
  - event streams, signatures and stored values round-trip;
  - cache keys never collide;
  - metrics stay in range.
- `verify/tests/fixtures/user-inputs.ts` collects the inputs. `verify/tests/support/` has:
  - an HTTP client;
  - a parser that reads an event stream exactly as the browser does;
  - `EventStreamTab`, a browser tab with a stream open;
  - `Gate`, which holds code at a point the test chooses;
  - the generators.
- `npm test` runs `verify/tests/**/*.test.ts`. The tests share one `waitFor` helper instead of three.

## 0.5.0 — 2026-10-22

### Fixed — latent bugs, round 3
Every reference file was read again, and each suspected failure was written down as a hypothesis and as a test of
the behaviour the skill promises. All 34 tests failed on 0.4.0 and pass now
(`verify/tests/regressions/round-3.test.ts`). One more hypothesis was refuted: an any-word tsquery built with
`quote_literal` can't break on user input, because Postgres's `simple` parser never yields a lexeme with a
backslash or a quote.
- `webhook-ingestion`: a handler slower than `stuckAfterSec` was claimed again and run alongside the first, and both
  credited the payment. A worker that had lost its event could also put it back to `pending` after another worker
  finished it. Each claim now carries a `lease_id`, and the handler's transaction locks its own row as the lease
  holder: `SKIP LOCKED` then passes over it, and a worker that lost its row gets `lost`.
- `llm-gateway`:
  - a cache or budget-store error after the model answered was treated as a provider failure: the fallback was
    called (a second paid answer), the healthy provider's breaker counted a failure, and the reservation stayed.
    After the answer, settling and caching are now best effort, reported through the new `onError`.
  - A cache store that was down failed every request; it is now skipped.
  - When a breaker's cooldown ended, every waiting request called the dead provider (10 calls instead of 1 probe).
  - A request already cancelled was still sent.
  - Fallback answers were cached for 24 h; now 5 minutes (`fallbackCacheTtlSec`).
- `llm-tool-safety`:
  - the "untrusted content" taint lived in process memory, so the agent's next turn (a new request, maybe another
    instance) ran writes without approval. It is now stored per conversation (`tool_sessions`, a `TaintStore` port).
  - A retried approved call was refused as "approval already used" instead of replaying its result.
  - `decide()` accepted an approver from another tenant; it now takes `{ tenantId, userId }`.
  - A tool call left `running` by a crash blocked its id forever; it is taken over after `staleRunSec`.
- `idempotency-keys`: a request whose stale claim had been taken over could delete the new owner's claim when it
  failed, so a third retry ran the charge again. Claims carry a `claim_token` now.
- `job-queue`: in a batch, only the running job was heartbeated. The jobs waiting behind it expired, were rescued,
  and could go dead without ever running. Stopping a worker also ran out the whole batch; it now hands unstarted
  jobs back without spending their attempt.
- `data-retention-and-erasure`:
  - two instances processing the same request could reopen it after it was completed and its subject id cleared,
    and it was then retried forever with `erase(null)`. Requests are now leased.
  - `processPending` miscounted completions when more than one batch was open.
  - An `anonymize` entry that left a personal column in place was accepted; the inventory is now checked at startup.
- `agent-safe-db`: the executor's own pool had no `error` listener (an idle connection ended by the server crashed
  the process), no connect timeout (a black-holed database hung every call) and no client-side query timeout.
- `rate-limiting`: the breaker had no half-open state (20 checks probed a dead Redis instead of 1); `check()` now
  refuses a cost outside (0, capacity], since a negative cost added tokens.
- `cache-stampede`: a hit returned a different shape than the miss that filled it (a `Date` came back as a string);
  a value JSON can't encode failed the request; a black-holed Redis cost 50 ms on every request. Values now go
  through a `Codec` on every path, unencodable values are served uncached, and Redis calls have a breaker.
- `sse-streaming`: event ids restarted at 1 with the process, so a client reconnecting after a deploy silently
  missed the new process's first events. Ids now start from the clock and an old id gets `reset`.
- `multitenant-postgres`: the RLS audit accepted a `USING (true)` policy; a third query flags permissive policies
  that don't filter by tenant.
- `rag-evals`: a retriever returning the same id twice scored recall 2; a golden set with new hard questions failed
  the gate (runs are now compared on shared queries, and added or removed ones are listed); `fillPrompt` mangled
  answers containing `$&` or `$'`.
- `llm-observability`: a reply with `content: null` (a tool call) made the redactor throw and turned a successful
  call into an error; recording can't throw any more. `otel-setup.ts` registered a SIGTERM listener that only
  flushed, which kept a service without its own handler running until SIGKILL; it exports `shutdownTelemetry`
  instead.
- `pii-redaction`: a custom detector without the `g` flag redacted only the first match, and a hint with it skipped
  every other string. Both are refused at startup.
- `zero-downtime-migrations`: a backfill batch that lost a deadlock failed the whole backfill; it is retried, and a
  final error carries `lastId`. The linter now flags `ADD COLUMN … NOT NULL` without a default.
- Found while refactoring: `adr-writer`'s `new-adr.mjs` filled its template with `replaceAll`, so a title with `$&`
  came out garbled.
- Tests: the outbox resilience test raced two network events, Toxiproxy's API answer and the relay socket's close,
  and once saw 6 sends instead of 4 on CI. The relay can only stop for a drop it has seen. The test now waits until
  the connection noticed, and the docs say "once it notices" instead of "as soon as the connection dies". The
  round-3 idempotency test waits for each claim instead of sleeping a guessed 100 ms.

### Changed — architecture
- Stateful components are classes behind the same `createX()` factories: `OutboxRelay`, `InboxWorker`, `JobWorker`,
  `Scheduler`, `IdempotencyKeys`, `LlmGateway`, `ToolGuard`/`ToolSession`, `DataLifecycle`, `AgentDb`,
  `RateLimiter`, `ReadThroughCache`, `SseStream`, `ReplayBuffer`, `Toxiproxy`. Pure logic stays functions, and the
  redactor and the hardened server stay closures, because their functions are passed around detached.
- A shared kernel in `shared/` (`withClient`/`withTransaction`, `CircuitBreaker`, `withTimeout`, `runLoops`),
  vendored into each skill that imports it. `npm run sync:shared` copies it, and `npm run validate` fails on a copy
  that drifts.
- `docs/architecture.md`: when to use a class, a function or a closure; the ports; the nine invariants.
- New: `OutboxRelay#run()`, the relay loop the other workers already had.
- To upgrade from 0.4.0:
  - run the SQL files again: they add `webhook_inbox.lease_id`, `idempotency_keys.claim_token`,
    `tool_results.claim_token`, the `tool_sessions` table, and `erasure_requests.lease_id`/`locked_until`;
  - `ToolGuard#decide` takes `{ tenantId, userId }`, and `ToolSession#markUntrusted` returns a promise;
  - `pgUsageSink` rejects on a failed write (the gateway hands it to `onUsageError`);
  - cache entries have a new format: old ones read as misses and are overwritten. Bump the prefix version to drop
    them at once.

### Tooling
- `npm run typecheck`: strict TypeScript over the reference code and the shared kernel, with `erasableSyntaxOnly`,
  which rejects what Node's type stripping can't run (enums, namespaces, parameter properties). Node never checks
  types, so before this a type error in reference code went unnoticed. It now runs in CI and in the release job.
  The code passed it as is.
- `npm run sync:shared`, and `npm run validate` checks that every vendored copy of the shared kernel is identical.

### Performance
- The semantic cache lookup in shadow mode runs beside the model call: 108 ms per request instead of 206 ms
  (100 ms embedding, 100 ms model).
- 20 requests through the cache with Redis black-holed: 181 ms instead of 1,236 ms.
- Re-measured inside the Docker network after the refactor: the outbox relay, rate limiter, webhook claim and
  drain, job claim and idempotency stayed within run-to-run noise of 0.4.0. The webhook worker makes one more round
  trip per event (locking its row): about 3% on a drain with 5 ms handlers.
- One regression was caught by those measurements and fixed before release. Idempotency replays went from 0.84 ms
  to 1.75 ms, because the refactored early return committed instead of rolling back. `ON CONFLICT DO UPDATE` locks
  the existing row even when it changes nothing, so the commit cost a WAL flush. It rolls back again (0.82 ms).

## 0.4.0 — 2026-10-22

### New skill: `job-queue`
Background jobs on Postgres. A job is enqueued in the business transaction and claimed with SKIP LOCKED. While it
runs it is leased, and heartbeats renew the lease. A failing job retries with jittered backoff, then becomes a dead
letter that `retryDead` can replay. The queue also supports unique jobs, delayed jobs, and recurring jobs that fire
exactly once across instances; `run()` stops gracefully, and finished jobs are pruned.
- 12 tests against real Postgres. They cover a worker that dies after claiming (the job runs exactly once more), a
  worker frozen past its lease (its late result is discarded), a handler that ignores its abort signal, and three
  scheduler instances ticking at once.
- Benchmarked three table designs next to 1,000,000 finished jobs and 100,000 delayed ones. An idle poll costs
  73 ms with an index on `run_at`, 3.4 ms with one `pending` state, and 0.3 ms with the shipped separate
  `scheduled` and `available` states.

### New skill: `zero-downtime-migrations`
Change a live schema without stalling the app.
- `runStep` runs each step under `lock_timeout`, retries when the lock isn't granted, and drops the `INVALID`
  index a failed `CREATE INDEX CONCURRENTLY` leaves behind.
- `backfill` updates in short batches and resumes where an interrupted run stopped.
- `lintMigration` flags statements that lock the table or break the version of the app still running.
- `patterns.md` has the expand/contract recipes, including the RLS retrofit for `multitenant-postgres`.
- 7 tests against real Postgres, including a DDL statement queued behind a long transaction, an insert during an
  index build, and `SET NOT NULL` shown to skip its scan after a validated `CHECK`.
- Benchmarked on a 1M-row table: a read behind a blocked `ALTER` waited 52 ms instead of 1 s, and an insert during
  an index build waited 2 ms instead of 1.5 s.

### New skill: `cache-stampede`
A Redis read-through cache that holds when a hot key expires: single-flight per process, a Redis lock across
instances, stale-while-revalidate, jittered TTLs, cached misses, tenant-scoped keys, and failing open when Redis is
down.
- 8 tests against real Redis, including three instances missing at once (one origin call), an instance that died
  holding the lock, and an origin outage while a stale value is served.
- Benchmarked with 4 instances × 50 requests: 1 origin call instead of 200 with plain cache-aside, and 0.7 ms
  instead of 141 ms while the entry is stale.

### New skill: `llm-tool-safety`
Guardrails for the tools an agent can call.
- Tools have tiers (read, write, destructive) and strict argument schemas. The tenant comes from the session.
- Once untrusted content is in the context, writes need a human approval bound to the exact arguments, single-use
  and expiring. Destructive tools always need one, optionally from a second person.
- Calls run once per `tool_call_id`, and every call is audited.
- 7 tests against real Postgres, including a poisoned document that asks for a refund and a deletion: nothing runs.

### New skill: `rag-evals`
Retrieval metrics (recall@k, MRR, nDCG, hit rate) with slices, a CI gate that lists the queries that broke, and an
LLM-judge harness whose agreement with human labels is measured before its scores are trusted.
- 4 tests, including the gate catching a real regression in `hybridSearch`, and a judge with 83% accuracy that
  still passed a false claim (kappa 0.57).

### New skill: `data-retention-and-erasure`
One inventory of where each person's data lives drives four things:
- erasure: every table in one transaction, external stores retried until done, and a durable request record that
  keeps only a peppered hash once complete;
- access exports;
- batched retention;
- a CI audit for personal columns nobody classified, Vietnamese column names included.

6 tests against real Postgres and Redis. After an erasure, a scan of every text column finds none of the person's
identifiers, and invoice amounts are kept.

### New skill: `resilience-testing`
Toxiproxy between the app and its dependencies, a small client to add latency, black holes, resets and outages from
tests, and a scenario catalog with the expected behaviour per fault. Toxiproxy now runs in the verify stack and in
CI. 6 tests run the kit's own reference code through it, and found:
- a server-side `statement_timeout` doesn't bound a slow network; a client-side `query_timeout` does;
- a pool without `connectionTimeoutMillis` waits forever for a black-holed database;
- an ioredis client without its offline queue fails every command until it has connected;
- the outbox relay bug below.

### New skill: `slo-alerting`
SLOs as code. `prometheusRules` generates recording rules and multi-window, multi-burn-rate alerts, `promtool`
checks and unit-tests them in CI, and a simulator shows what an incident would trigger.
- 5 tests: a 10% error rate pages in 9 minutes; a 0.2% slow burn opens a ticket after 36 hours and never pages;
  normal noise triggers nothing; Prometheus itself fires and resolves the generated rules as designed.

### Fixed
- `multitenant-postgres`: the keyword side of `hybridSearch` required every word of the query, so questions typed
  as sentences matched nothing there (0 of 10 in the eval). It now falls back to any word when nothing matches every
  word: 10 of 10, with search-box ranking unchanged.
- `outbox-pattern`: when the database connection died mid-batch, the relay kept publishing the rest of the batch,
  and all of it went out again on the next run. It now stops before the next publish.
- `rate-limiting`, `cache-stampede` and the service-hardening checklist now say to connect Redis before reporting
  ready when the offline queue is off. The checklist also requires `connectionTimeoutMillis` and a client-side
  `query_timeout` on Postgres pools.

### Docs
- README: an "Incidents it is tested against" table, and the new comparisons.
- `docs/performance.md`: schema changes on a live table, a hot key expiring under load, the keyword side of hybrid
  search.
- `docs/roadmap.md`: all nine ranked candidates are built.

### CI/CD
- Toxiproxy runs as a service in the CI and release jobs. The SLO test runs `promtool` from the official
  Prometheus image.

## 0.3.0 — 2026-10-21

### New skill: `idempotency-keys`
Stripe-style `Idempotency-Key` handling in Postgres for retried POSTs and agent tool calls. A retry gets the
first response back instead of a second order, charge or email. A duplicate arriving mid-flight gets 409, and a key
reused for another request gets 422.
- `runIdempotent` covers effects in the same database: claim, effect and stored response commit in one
  transaction, so a crash leaves nothing behind.
- `runIdempotentExternal` covers payment providers and other services: the claim commits first, the handler gets a
  `downstreamKey`, and a claim left by a dead process is taken over after `staleAfterSec`.
- 11 tests against real Postgres, including 20 concurrent copies of one request, a connection killed mid-handler,
  and a process that died after charging.
- Benchmarked against the two versions agents usually write:
  - check-then-insert ran the handler 20 times for 20 duplicates;
  - insert-and-wait held about 4 s of pooled connections;
  - the shipped try-lock answers duplicates with 409 in 8 ms and holds 0.13 s.

### Fixed — latent bugs, round 2
Each bug was reproduced by a failing test first (`verify/tests/regressions/round-2.test.ts`), then fixed.
- `llm-gateway`: with an HNSW index, the semantic cache filtered by tenant *after* the index returned its 40
  nearest rows across all tenants. A question many tenants had cached crowded out this tenant's own entry: 4 hits
  out of 20 for a big tenant, each miss a paid model call. Search is now exact within the scope by default, and
  `semanticSearch: 'ann'` uses pgvector 0.8 iterative scans.
- `webhook-ingestion`: the claim's `pending OR stuck` filter couldn't use either index's order, so every claim
  sorted the whole due backlog: 56 ms per claim at 200,000 events due. Two index-ordered branches now keep it at
  0.6 ms regardless of backlog.
- `outbox-pattern`: a publish call that never returned held the relay's transaction and advisory lock forever,
  silently stopping all delivery. New `publishTimeoutMs` (default 10 s).
- `service-hardening`: oversized uploads got a connection reset instead of the 413 (chunked and declared
  length), so clients retried the whole upload. The server now stops reading, delivers the 413 with
  `Connection: close`, and closes after `rejectLingerMs`.
- `sse-streaming`: a stalled feed subscriber buffered every event (40 MB in the test). `serveFeed` now drops a
  client more than `maxQueue` events behind; it reconnects with `Last-Event-ID`.
- `rate-limiting`: `refillPerSec: 0` made the Lua script divide by zero, so every check errored and the limiter
  ran in its failure mode. Non-positive or non-finite `capacity`/`refillPerSec` are rejected at startup.
- `llm-observability`: prompt and response attributes were unbounded (a 240 KB RAG prompt became one attribute).
  New `maxContentChars` (default 32 KiB) with a truncation marker.
- Retention: `pruneInbox` (done rows only, never dead letters, window longer than the provider's retry period)
  and `pruneLlmCache` delete in batches through new indexes; the tables used to grow forever.
- Every function that checks a client out of the pool crashed the **whole Node process** when Postgres ended the
  connection between two queries. That covered `withTenant`, `relayOnce`, `consumeOnce`, the webhook worker, the
  `ann` cache lookup and the agent DB tool. The trigger can be a failover, `pg_terminate_backend`, or
  `idle_in_transaction_session_timeout` during a slow handler or publish.
  - Cause: node-postgres emits `error` on the checked-out client, and nothing listened.
  - Fix: each function now listens while it holds the client. Only that request fails, and the pool drops the dead
    client.
  - Tests: `verify/tests/invariants/connection-loss.test.ts` kills the connection inside each one, and it fails without the fix.
  - The service-hardening checklist now also requires `pool.on('error')`; an idle pooled client hits the same crash.

### Performance — approach comparisons (`bench/compare/`, tables in docs/performance.md)
Each hot path's alternatives were measured side by side inside the Docker network, and the winner shipped:
- Embeddings are sent as binary parameters (`vectorParam`) in `llm-gateway` and `multitenant-postgres`: about 3×
  faster lookups and inserts, 6 KB instead of 32 KB per 1536-dim vector, identical results.
- `llm_semantic_cache.embedding` is stored in the row (`SET STORAGE MAIN`): exact search 2–3× faster. Combined
  with binary parameters, a small-scope lookup went from 2.1 ms to 0.46 ms.
- The HNSW index on the semantic cache is now opt-in: it made every cache save 7× slower and the default search
  never uses it.
- `webhook-ingestion`: new `worker.run({ loops, signal })`, with independent loops and a graceful stop that
  finishes claimed rows. It drains 1.8× faster than lanes over one batch when some handlers are slow.
- `outbox-pattern`: one `UPDATE` per batch instead of per message: 8.3× relay throughput, same crash behaviour.
- `llm-gateway`: budget reservation is one conditional upsert instead of two statements: 20% lower latency,
  37% more throughput, still exact under contention.
- `multitenant-postgres`: `withTenant` sends `BEGIN` and `set_config` in one round trip (the tenant id is
  validated as a UUID first, and a test feeds it injection strings), 19% faster per request. Measured that RLS
  itself costs about nothing with a `STABLE` function, and 380× more with a `VOLATILE` one; the skill now warns.
- Measured and kept as they were: the rate limiter's ioredis defaults (auto-pipelining was 11% slower for
  `EVALSHA`) and per-detector redaction with hints (1.3–4.7× faster than the alternatives).
- Found while measuring: from the host, Docker Desktop's port forwarder adds ~44 ms to every message of 16 KB or
  more. New `npm run bench:docker` runs database benchmarks inside the Docker network.

### Docs
- `docs/performance.md`: every comparison with its table, query plans and trade-offs.
- `docs/roadmap.md`: skills that would fit next to these (a Postgres job queue, zero-downtime migrations, LLM
  tool safety, and more), with the proof each would need. Its first entry, `idempotency-keys`, ships in this release.
- README: the new production bugs and a "measured against the alternatives" table.

## 0.2.0 — 2026-10-21

### Fixed — latent bugs in the reference code
Each bug was reproduced by a failing test first (`verify/tests/regressions/round-1.test.ts`), then fixed.
- `pii-redaction`: the email pattern's unbounded local part made redaction O(n²) on long strings. A 50 KB log
  line without `@` took ~1.9 s, a denial-of-service through the logging path. Quantifiers are now bounded,
  detectors have cheap pre-checks, and strings over 16 KiB are truncated before scanning.
- `llm-gateway`: a model missing from the price table was costed at $0, so budgets silently never limited
  anything. The gateway now refuses to start with budgets enabled and an unpriced model.
- `llm-gateway`: a call that crossed a month boundary settled in the new month and left its reservation stuck in
  the old one. The period is now captured once per call.
- `rate-limiting`: the local fallback evicted in insertion order, so the busiest subject was evicted first and
  came back with a full bucket. Eviction is now true LRU.
- `multitenant-postgres`: `SET LOCAL hnsw.iterative_scan` aborts the transaction on pgvector 0.5–0.7 once the
  library is loaded (a reserved prefix), which bites on reused pooled connections. It is now only set when
  supported.
- One suspected bug was a false positive: the readiness-check timeout in `service-hardening` does not leak an
  unhandled rejection, because `Promise.race` subscribes to it.

### Performance (`bench/run.ts`, numbers in docs/performance.md)
- Redacting a 50 KB log string: 1,891 ms → 0.22 ms. Structured log records: +71% throughput.
- `webhook-ingestion`: new `concurrency` option; 200 events with 5 ms handlers drain in 454 ms instead of
  3.2 s, still exactly once.
- `rate-limiting`: `EVALSHA` with a `NOSCRIPT` fallback instead of resending the script on every check. There
  is no measurable difference on localhost; it saves bytes per request on real networks.

### CI/CD
- CI: a new `validate-skills` job (frontmatter rules enforced on skill upload, broken links, eval sets kept
  outside `skills/`) and an informational benchmark run.
- CD: pushing a `v*` tag runs validation and all tests, packages every skill as a `.skill` file plus a kit
  zip, and publishes a GitHub release with notes taken from this changelog.

### Docs
- The README is rewritten around measured effect: what the agent shipped with and without each skill, and the
  production bugs the kit prevents.

## 0.1.0 — 2026-10-21

First public version.

### Skills
- 11 skills: `agent-safe-db`, `pii-redaction`, `multitenant-postgres`, `webhook-ingestion`, `outbox-pattern`,
  `rate-limiting`, `service-hardening`, `llm-gateway`, `llm-observability`, `sse-streaming`, `adr-writer`.
- Each skill has decision points to ask about, implementation steps, required verification and common mistakes,
  with reference code in `references/`.

### Verification
- 108 tests in `verify/tests` against real Postgres 17 + pgvector and Redis 7 (Docker), run in CI.
- Bugs caught while writing them and fixed in the reference code: an unhandled rejection that crashed Node when
  a Redis call lost a `Promise.race` timeout (`rate-limiting`); superusers silently bypassing RLS even with
  `FORCE` (`multitenant-postgres` now warns and tests it).

### Evaluation (skill-creator, 3 iterations)
- `agent-safe-db`, `webhook-ingestion` and `llm-gateway` evaluated with and without the skill on 6 prompts;
  see [docs/evaluation.md](docs/evaluation.md).
- Changes driven by the evaluation:
  - `llm-gateway`: atomic reserve-then-settle budgets (concurrent requests can't overshoot), semantic cache in
    shadow mode by default, usage-sink failures never fail a request.
  - `agent-safe-db`: write tests must turn `read_only` off and assert `42501`; tenant scoping and PII masking in
    the database; `CREATE`/`TEMP` revoked for raw-SQL roles; guest-chat decision point.
  - `webhook-ingestion`: sign test payloads with the provider's own tooling; assert "processed once" through the
    worker; read-only return URLs; inline validation reads for VNPay `RspCode`.
  - Eval sets moved from `skills/*/evals/` to `evals/` after a with-skill run read its own rubric.
