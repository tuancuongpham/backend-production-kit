# ADR-{{NUMBER}}: {{TITLE}}

- **Status:** {{STATUS}}
- **Date:** {{DATE}}
- **Deciders:** <names or roles>
- **Related:** <other ADRs, skills, tickets>

## Context
<The forces at play: requirements, constraints, current numbers (traffic, data size, cost, team size). 3–8 sentences. A reader in two years should understand why this was a question at all.>

## Decision drivers
- <e.g. "a query that forgets a tenant filter must return nothing, not everything">
- <e.g. "p99 latency under 300 ms at 2× current peak">

## Options considered
### Option A: <name>
- Pros:
- Cons:
- Cost / effort:

### Option B: <name>
- Pros:
- Cons:
- Cost / effort:

## Decision
<"We will …", with the concrete parameters: timeouts, thresholds, limits, versions.>

## Consequences
- Positive:
- Negative / costs we accept:
- Risks and mitigations:

## Verification
<How we know it holds: test names, benchmark reports, dashboards, alerts. If not verified yet, write "Not yet verified" and what will verify it.>

## Revisit when
<Concrete triggers: "a tenant exceeds 30% of rows", "p99 > 500 ms for a week", "LLM price change > 20%".>
