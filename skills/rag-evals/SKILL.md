---
name: rag-evals
description: Measure RAG quality with numbers instead of spot checks — a labelled golden set, retrieval metrics (recall@k, MRR, nDCG, hit rate) with slices by query type, a CI gate that fails a pull request when retrieval regresses and lists the queries that broke, and an LLM-as-judge harness whose agreement with human labels (Cohen's kappa, false passes) is measured before its scores are trusted. Use whenever the user builds or changes retrieval (chunking, embedding model, hybrid search, reranking, prompts), asks whether answers got better or worse, wants evals in CI, or mentions RAG evaluation, golden set, recall@k, LLM judge, hallucination rate, Ragas, "đánh giá chất lượng RAG", "bot trả lời sai sau khi đổi model".
---

# RAG evals: retrieval regressions caught in CI

RAG quality degrades silently:
- someone changes the chunk size, swaps the embedding model, "cleans up" the search query, or edits the prompt;
- three hand-picked questions still look fine;
- a week later, users who type Vietnamese with accents, or who ask full questions instead of keywords, get worse
  answers, and nobody can say when it started.

The fix is a labelled set of real queries scored on every change, with the gate looking at slices, not only the
average.

```
golden set (real queries → relevant chunk ids, tagged by type)
  ├─ evaluateRetriever(golden, retrieve, k) → recall@k, MRR, nDCG, hit rate, per tag, per query
  ├─ compareReports(main, branch, gate)     → pass/fail + the queries that lost results → PR comment
  └─ answers: judge(question, context, answer) → pass/fail, trusted only after kappa vs humans
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Golden set | 100–200 real queries from logs, labelled with the chunks a good answer needs; refreshed quarterly | Don't write queries yourself: you'll write them in the corpus's own words, and keyword search will look perfect. |
| Slices (tags) | Query form (keywords / question), language and accents, tenant size, topic | Gate per slice: an average hides a broken slice. |
| k | The number of chunks the prompt actually gets | Recall@20 is meaningless if the prompt only sees 5. |
| Gate | Recall@k may not drop more than 0.02, MRR 0.02, any slice 0.05 | Compare with main on the same golden set and the same index, not against a fixed number. |
| Answer judging | An LLM judge per property (groundedness first), checked against ≥ 50 human-labelled answers | Below ~0.6 kappa, or with false passes on safety-relevant cases, report its scores but don't gate on them. |
| Where it runs | CI on every change to retrieval or prompts; nightly against production data | Retrieval runs against a seeded index in CI. Answer judging costs model calls: sample it. |

## Implementation steps

1. **Build the golden set.**
   - Sample queries from logs and stratify them by the slices above.
   - Label the relevant chunk ids. Two people per query catches disagreement; drop or fix the ambiguous ones.
   - Store it in the repo as JSON (`GoldenQuery[]`), with stable chunk ids (document id + ordinal, not random uuids).
2. **Score retrieval** with `evaluateRetriever(golden, retrieve, k)` from
   [references/retrieval-eval.ts](references/retrieval-eval.ts). The retriever is any function from a query to
   ranked ids, so the same harness checks hybrid search, each retriever alone, a reranker or a new embedding model.
   Score each retriever alone too: the fused number hides which side does the work. Duplicate ids count once, so
   evaluating at the document level (chunks mapped to their documents) can't push recall above 1.
3. **Gate in CI.** Score main and the branch, then call `compareReports(baseline, candidate)`. Post `toMarkdown(…)`
   as a PR comment, and fail the job when `pass` is false. The comment lists the queries that lost results, which
   is where debugging starts. Both runs are compared on the queries they share, and added or removed queries are
   listed: a pull request that adds hard questions to the golden set lowers the average without anything getting
   worse, and must not fail the gate for it. Two runs with a different `k` fail the gate. recall@10 against the
   baseline's recall@5 always looks like progress, so a pull request that changes `k` re-scores main with it.
4. **Judge answers** with [references/judge.ts](references/judge.ts).
   - Ask one property at a time (`GROUNDEDNESS_PROMPT`: is every claim supported by the context?).
   - Before trusting a judge, run it on human-labelled answers and check `judgeAgreement(…)`: kappa, and above all
     `falsePasses`.
   - Re-check when the judge model or prompt changes.
5. **Close the loop.** Log retrieval ranks and judge verdicts on traces (`llm-observability`). Production queries
   that users flag become golden-set candidates.

## Verification (required)

[verify/tests/skills/rag-evals.test.ts](../../verify/tests/skills/rag-evals.test.ts) covers:
- Metrics on hand-checked rankings (recall@k, precision, MRR, nDCG).
- **A real regression caught on Postgres hybrid search** (`multitenant-postgres`), on a 12-chunk Vietnamese help
  center:
  - with `kit_unaccent` dropped from the query side, the gate fails on the "accents" slice and lists the queries that
    broke;
  - queries typed without accents still pass, which is exactly why a spot check would have missed it.
- The unchanged code passes its own gate.
- Cohen's kappa on worked examples.
- A cheap judge that looks 83% accurate has a kappa of only 0.57 and passed "every order ships free". The agreement
  report shows it before anyone gates on it.
- [regressions/round-3.test.ts](../../verify/tests/regressions/round-3.test.ts): a retriever returning one document
  twice scores recall 1, not 2; adding a hard question to the golden set passes the gate; an answer containing
  `$&`, `$'` or `{{context}}` reaches the judge prompt as written.

How to write these tests so they prove something:
- Feed the gate a realistic broken retriever (a removed normalization, a smaller candidate pool, another model) and
  assert that it fails, and on which slice. A gate that only ever passes proves nothing.
- Keep the corpus in the test's own language and script. Accents, mixed language and abbreviations are where
  retrieval actually breaks.

## Record the decision
ADR: golden set source, size and refresh cadence, slices, k, gate thresholds, judge model, and its measured agreement.

## Common mistakes
- **Only scoring the average.** Dropping `kit_unaccent` from the query cut recall@5 from 1.0 to 0.42; the "accents"
  slice fell to 0.30 and queries typed without accents stayed at 1.0 ([performance](../../docs/performance.md)).
- **Not scoring each retriever alone.**
  - The AND-only keyword search found 0 of 10 questions asked in full sentences ("làm sao thanh toán bằng ví
    MoMo?"), while keyword-style queries scored 1.0.
  - The fused result hid it, because embeddings carried those questions.
  - `multitenant-postgres` now falls back to any-word matching (10 of 10).
- A golden set written by the developer who wrote the chunks.
- Comparing against a fixed threshold instead of against main: the number drifts with the corpus, and nobody knows
  whether a change helped.
- Trusting an LLM judge's pass rate without measuring it against humans. It fails in one direction: it passes
  confident, unsupported answers.
- Evaluating with k larger than what the prompt receives.
- Filling a prompt template with `replace(placeholder, text)`. In a replacement string, `$&` and `$'` are patterns,
  so an answer containing them reaches the judge mangled. Use a replacer function, in one pass.
