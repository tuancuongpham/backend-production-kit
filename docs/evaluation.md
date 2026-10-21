# Evaluation

Three skills — `agent-safe-db`, `webhook-ingestion` and `llm-gateway` — were evaluated with
[skill-creator](https://github.com/anthropics/skills) over three iterations. The prompts and assertions live in
[`evals/`](../evals).

## Method

- **6 realistic prompts**, 2 per skill, written the way a user would ask (some in Vietnamese).
- For each prompt, an agent (Claude Opus 5.5) ran the task **with the skill** and **without it** (baseline),
  writing code, SQL, tests and a `DECISIONS.md` to an output folder. No user was available, so every question the
  agent would ask was recorded with the default it chose. Runs could not start databases or install packages.
- Independent **grader agents** checked each output against 8–10 written assertions, quoting file evidence for
  every pass, and suggested how to make the assertions stricter.

| Prompt | Skill |
|---|---|
| 1. Support chatbot that looks up orders in Postgres | `agent-safe-db` |
| 2. "Just let the model write the SQL" text-to-SQL for ops | `agent-safe-db` |
| 3. VNPay IPN that sometimes credits twice | `webhook-ingestion` |
| 4. Stripe webhook for `payment_intent.succeeded` / `charge.refunded` | `webhook-ingestion` |
| 5. OpenAI bill tripled — cap cost per customer, find the top spenders | `llm-gateway` |
| 6. Semantic cache so similar questions don't cost twice | `llm-gateway` |

## Results

| Prompt | Iter. 1 (v1 rubric) | Iter. 2 (v2 rubric) | Iter. 3 (v2 rubric) |
|---|---|---|---|
| 1. Order lookup bot | 8/8 – 6/8 | 9/9 – 4/9 | 9/9 – 4/9 |
| 2. Text-to-SQL | 8/8 – 6/8 | 8/9 – 4/9 | **9/9** – 4/9 |
| 3. VNPay IPN | 8/8 – 8/8 | 10/10 – 8/10 | 10/10 – 8/10 |
| 4. Stripe webhook | 8/8 – 6/8 | 8/9 – 6/9 | **9/9** – 6/9 |
| 5. LLM budget / FinOps | 8/8 – 7/8 | 8/10 – 7/10 | **10/10** – 7/10 |
| 6. Semantic cache | 8/8 ⚠ – 6/8 | 10/10 – 9/10 | 10/10 – 9/10 |
| **Mean pass rate** | **100% – 81%** | **93% – 66%** | **100% – 66%** |

Each cell is *with skill – without skill*. Bold marks runs redone with the improved skills.

## What each iteration changed

**Iteration 1.** The skill won every prompt except VNPay (tie), but the result had two problems:

- the with-skill run for prompt 6 had read `evals.json`, which then sat inside the skill folder and contained the
  assertions (marked ⚠). Eval sets were moved out to `evals/` at the repository root;
- with-skill scored 100% everywhere, so the rubric could not tell good from great.

**Iteration 2.** Graders' findings were turned into changes in two places.

The skills:

- `llm-gateway` — the baseline reserved budget atomically while the skill only did read-then-call, which
  overshoots under concurrency. The skill now uses reserve-then-settle (proved by a test with 10 concurrent
  requests against room for 3, across two app instances), defaults the semantic cache to shadow mode, and never
  fails a request when usage accounting fails.
- `agent-safe-db` — write tests must turn `read_only` off and assert SQLSTATE `42501`; a test that expects "some
  error" passes even when the role has `UPDATE`. Tenant scoping and PII masking belong in the database; raw-SQL
  roles also lose `CREATE`/`TEMP`.
- `webhook-ingestion` — sign test payloads with the provider's tooling (a test that signs with the verifier's own
  HMAC can't catch a shared bug); assert "processed once" on the business effect through the worker; return URLs
  are read-only.

The rubric was rewritten as v2 (57 assertions): masking at DB level, GRANT-boundary tests, inbox/DLQ for VNPay,
concurrency-safe budgets, cross-tenant semantic misses, and more. Prompt 6 was rerun cleanly. Prompts 1–5 were
*regraded* on their iteration-1 outputs, so the with-skill misses on 2, 4 and 5 were exactly the gaps just fixed.

**Iteration 3.** Prompts 2, 4 and 5 were rerun with the fixed skills (eval sets hidden; graders confirmed no rubric
was read). Each moved to a perfect score for the reason the fix targeted:

- prompt 2: `TEMP` revoked, and `CREATE TEMP TABLE` tested with `read_only` off;
- prompt 4: tests signed with `stripe.webhooks.generateTestHeaderString`, and 10 concurrent duplicates checked to
  produce one payment row;
- prompt 5: atomic reservation tested in memory and across two Postgres instances, plus a test where the usage
  write fails.

## Where the baseline did better

- Prompt 5, iteration 1: the baseline had atomic reserve/settle before the skill did. That is what prompted the
  `llm-gateway` fix.
- Prompt 4, iteration 1: the baseline signed its tests with Stripe's own helper. That is what prompted the
  `webhook-ingestion` change.
- Prompt 3: a synchronous design that credits under a row lock, justified in `DECISIONS.md`, is a reasonable
  fix for VNPay. The v2 rubric penalises it twice (inbox, and DLQ/replay) for one architectural choice.

## Limits — read before quoting these numbers

- **One run per configuration**, so there is no variance estimate.
- **The rubric was written by the skill author**, after the skills, so it is biased toward what the skills
  teach. The skills' own `verify/tests` (which the agent reads) overlap with several assertions by design.
- **No generated test was ever executed against a database**: the runs weren't allowed to start one, and every
  verdict comes from reading code. Several outputs depend on SDK calls written from memory.
- **Ceiling.** With-skill is back at 100% on v2, so a v3 rubric needs harder assertions to keep improving the
  skills. Graders proposed: a reservation estimate at least as large as the real cost, a Stripe amount checked
  against the stored order, a single-tenant replica scope for raw SQL, and evidence that tests actually ran.
- **Time and tokens are not comparable.** Every iteration-1 run was interrupted by a usage limit and only the
  resumed segment was measured. Clean reruns took 10–16 minutes and 150–200k tokens each.
