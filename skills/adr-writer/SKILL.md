---
name: adr-writer
description: Record architecture decisions as numbered ADRs (context, options, decision, consequences, verification, revisit triggers), write benchmark reports, and turn a project into a public architecture write-up with diagrams and real numbers. Use whenever a design choice with real alternatives gets made or changed (database, queue, cache, auth, failure mode, timeout, model choice), when the user asks for an ADR, design doc, "tại sao chọn X", tech blog/case study, portfolio write-up, or benchmark report — and at the end of every other backend-production-kit skill.
---

# ADRs, benchmarks and write-ups

Senior engineers get hired, and systems stay maintainable, because of **judgement that can be inspected later**. An ADR captures the one thing code can't: why this option, over which alternatives, under which constraints, and when to reconsider. Benchmarks keep that judgement honest. Write-ups make it visible.

## When to write an ADR, and when not to
Write one when a choice has **real alternatives and lasting consequences**: data model, isolation model, queue vs table, fail-open vs fail-closed, build vs buy, model and provider, timeouts that encode a trade-off. Don't write one for things with one sensible answer (formatting, a library patch bump).

## Steps

1. **Gather facts before writing.** Constraints, numbers (traffic, data size, costs), and which options were actually considered. If a decision point came from another skill's table, use the user's answer and its reason. Ask when you don't know the "why"; never invent it.
2. **Create the file** with the script. It numbers, slugifies (handles Vietnamese), fills the date and status, and refreshes `docs/adr/README.md`:
   ```bash
   node <skill-dir>/scripts/new-adr.mjs "Rate limiter fails closed on LLM routes" --status Accepted
   node <skill-dir>/scripts/new-adr.mjs "Move keyword ranking to ParadeDB BM25" --supersedes 4
   ```
   `--supersedes N` marks the old ADR as superseded and cross-links both. ADRs are never edited to say something different; they are superseded.
3. **Fill the template** ([assets/adr-template.md](assets/adr-template.md)):
   - *Context*: the forces, with numbers. Someone reading it in two years should see why this was a question at all.
   - *Options*: at least two real ones, each with pros, cons and cost. "Do nothing" counts when it is viable.
   - *Decision*: "We will …", plus the concrete parameters (threshold 0.95, timeout 50 ms, 8 attempts).
   - *Consequences*: include the costs you accept. An ADR with no negatives wasn't thought through.
   - *Verification*: the test names or benchmark that prove it. "Not yet verified" is allowed when stated.
   - *Revisit when*: concrete triggers, not "if needed".
4. **Benchmarks** ([assets/benchmark-template.md](assets/benchmark-template.md)): record setup and versions, method (tool, duration, concurrency, warm-up), p50/p95/p99, throughput, error rate, cost per 1k requests, and **threats to validity**. Commit the raw output next to the report. **Never present estimated numbers as measured.** If there is no run, say "estimate" and show the arithmetic.
5. **Public write-up** (project #15) ([assets/writeup-template.md](assets/writeup-template.md)): problem first, a Mermaid architecture diagram, a key-decisions table linking ADRs, numbers linked to benchmark reports, and an honest "what went wrong" section. Strip customer names, secrets, internal hostnames and anything under NDA before publishing, and ask the user to confirm that.

## Verification
[verify/tests/adr-writer.test.ts](../../verify/tests/adr-writer.test.ts): sequential numbering, Vietnamese slugs, no unfilled `{{placeholders}}`, supersession links both ways, index regenerated with statuses.

For content quality, re-read the finished ADR and check: does each option have a real con? Is there a number in Context? Does Verification name something runnable? Is there at least one concrete revisit trigger?

## Common mistakes
- Writing ADRs after the fact as justification: the rejected options become straw men.
- A decision with no parameters ("we'll add caching"), which you can't tell is still being followed.
- Benchmarks without versions or hardware, which can't be compared later.
- Editing an accepted ADR instead of superseding it, which loses the history.
