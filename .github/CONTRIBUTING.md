# Contributing to backend-production-kit

Thanks for taking the time to help! Bug reports, new patterns, sharper tests and better wording are all welcome.

## Reporting a problem

Open an issue with:

- which skill (`skills/<name>/SKILL.md`) or reference file is wrong or missing something;
- what an agent built from it, what you expected, and why it matters in production;
- if you can, a failing test in `verify/tests` that shows the problem.

Security problems: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Requirements: Node 24+ (runs the `.ts` reference code directly) and Docker.

```bash
npm install
npm run verify:up     # Postgres 17 + pgvector on :55439, Redis 7 on :63799
npm test              # all verification tests
npm run test:unit     # the subset that needs no Docker
npm run verify:down
```

## Project layout

- `skills/<name>/SKILL.md` — what the agent reads: when to use the skill, the decision points to ask the user
  about, the implementation steps, the required verification and common mistakes.
- `skills/<name>/references/` — reference code and SQL the skill points to (`adr-writer` has `assets/` and
  `scripts/` instead).
- `verify/` — Docker Compose for test infrastructure and `tests/*.test.ts`, which prove each reference file
  does what its skill claims, against real Postgres and Redis.
- `evals/<name>/evals.json` — prompts and assertions for evaluating skills with skill-creator. They live outside
  `skills/` on purpose: an agent using a skill must not be able to read the rubric it is graded on.
- `docs/` — README translation and evaluation results.

## Before you open a pull request

```bash
npm run verify:up
npm test
```

CI runs the same tests against Postgres and Redis service containers on every pull request.

- **Every claim in a SKILL.md needs a test.** If a skill says "duplicates are processed once" or "the agent role
  cannot write", `verify/tests` should prove it. Tests must prove the real boundary: for example, a write test
  for the agent role turns `read_only` off and asserts SQLSTATE `42501`, otherwise it only tests the soft guard.
- **Decision points stay decisions.** When a choice depends on the user's context (fail-open vs fail-closed,
  thresholds, timeouts), put it in the skill's decision table with a default and the reason — don't hardcode it.
- Keep `SKILL.md` under ~500 lines and its `description` under 1024 characters, with no `<` or `>`.
- Keep changes focused: one skill or one fix per pull request.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](../LICENSE).
