# Verification

Every claim a skill makes ("a duplicate webhook is processed once", "tenant A never sees tenant B's rows") is proved
here, against real Postgres 17 with pgvector, Redis 7 and Toxiproxy from [docker-compose.yml](docker-compose.yml).
Nothing is mocked that the claim depends on.

## Layout

| Folder | What its tests prove | Add a test here when |
|---|---|---|
| [`tests/skills/`](tests/skills) | What each skill's SKILL.md claims, one file per skill | a skill gains or changes a claim |
| [`tests/kernel/`](tests/kernel) | The contracts of the shared kernel in [`shared/`](../shared) | a kernel file changes |
| [`tests/journeys/`](tests/journeys) | Several skills wired over real HTTP the way an application wires them, driven through what users, providers and models do: retries, double taps, closed tabs, deploys, forged requests, edited URLs | a bug only shows end to end |
| [`tests/properties/`](tests/properties) | Rules over generated input (fast-check): what must hold for *any* text, value or sequence | a rule should hold for every input, not five examples |
| [`tests/regressions/`](tests/regressions) | Each review round's hypotheses, `round-N.test.ts`; every one failed on the code before its fix | a review finds a latent bug |
| [`tests/invariants/`](tests/invariants) | A rule every skill keeps, checked across all of them | a bug class could hide in any skill |
| [`tests/fixtures/`](tests/fixtures) | Realistic input: Vietnamese text in its forms, phone and id formats, secrets, NUL, half emoji | — |
| [`tests/support/`](tests/support) | The infrastructure endpoints, an HTTP client, a browser-exact event-stream reader, a `Gate` that holds code at a chosen point, the generators | — |

## Running

```bash
npm run verify:up          # Postgres, Redis and Toxiproxy in Docker
npm test                   # everything, one file at a time
npm run test:unit          # the part that needs no Docker
npm run test:journeys      # or: test:skills, test:kernel, test:properties, test:regressions
npm run coverage           # everything, with the coverage thresholds CI enforces
npm run verify:down
```

`KIT_PG_URL`, `KIT_REDIS_URL` and `KIT_TOXIPROXY_URL` point the tests at other infrastructure (CI uses them for its
service containers). Property tests run a fixed seed. `KIT_FC_SEED=random` explores new input, and a failure prints
the seed that reproduces it: `KIT_FC_SEED=<seed> npm run test:properties`.

## Conventions

- **One fresh database per file** (`freshDatabase('kit_<name>')`) and a unique Redis prefix per test. Files run one
  at a time (`--test-concurrency=1`), because they share Redis and Toxiproxy.
- **A test name is a sentence about behaviour**: "a double tap sends the order twice at once: one order; the second
  tap gets 409 with Retry-After". It reads as the spec when it passes and as the bug report when it fails.
- **Assert on the effect**, not on a return value alone: rows in `refunds`, what the browser parsed from the stream,
  what the log line contains.
- **Real input.** Use `fixtures/user-inputs.ts` and `support/arbitraries.ts` rather than `"test"` and `"foo"`: the bugs
  live in Vietnamese text, `%00` and half an emoji.
- **Wait for the condition, not a guessed time**: `waitFor(() => …, 'what')` from `support/wait.ts`. A sleep is either
  flaky on a slow runner or slow everywhere else. Hold code at a precise point with `Gate` from `support/gate.ts`.
- **A test for a bug fails first.** Write it, watch it fail for the reason it names, then fix the code.
