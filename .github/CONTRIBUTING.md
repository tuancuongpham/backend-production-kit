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
- `shared/` — the building blocks several skills use (transactions that survive a dead connection, a circuit
  breaker, a promise deadline, worker loops). Skills ship separately, so each skill that imports one carries its
  own copy: edit the file in `shared/`, run `npm run sync:shared`, and `npm run validate` checks the copies.
- `docs/` — README translation, evaluation results, performance numbers, and
  [architecture.md](../docs/architecture.md): when to use a class or a function, ports and adapters, and the
  invariants every skill keeps.

## Before you open a pull request

```bash
npm run validate      # SKILL.md frontmatter, links, eval sets, shared-kernel copies
npm run typecheck     # strict TypeScript over the reference code (Node only strips the types)
npm run verify:up
npm test
npm run bench         # if you touched a hot path: compare with docs/performance.md
```

CI runs the same checks against Postgres and Redis service containers on every pull request.

- **Found a bug in reference code?** Add a failing test first (the skill's own test file, or the current review
  round's `verify/tests/latent-bugs-round<N>.test.ts`), then fix
  it and add the lesson to the skill's *Common mistakes*, so agents stop repeating it.

## Releasing

1. Bump `version` in `package.json` and `.claude-plugin/plugin.json`, and add a `## <version>` section to
   `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v<version> && git push origin v<version>`.
3. The Release workflow re-runs every check, packages each skill as a `.skill` file plus a kit zip, and
   publishes the GitHub release with the changelog section as notes.

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
