---
name: slo-alerting
description: Turn metrics into alerts people trust — SLOs as code (availability and latency objectives per user journey), Prometheus recording rules and multi-window multi-burn-rate alerts (page on fast burn, ticket on slow burn, auto-resolving with short windows) generated from the definitions and checked with promtool unit tests in CI, a simulator to see what an incident would trigger, and the signals every other skill in this kit already exposes. Use whenever the user sets up alerting or on-call (Prometheus, Alertmanager, Grafana, Datadog, Cloud Monitoring), defines SLOs or SLIs, has noisy or missing alerts, or mentions error budget, burn rate, uptime target, "cảnh báo liên tục mà không ai xem", "bị sập mà không ai biết".
---

# SLO-based alerting

Two failure modes. Too many alerts (CPU at 80%, one 500, a slow query) and people mute the channel. Too few, and
customers report the outage first. An SLO fixes the threshold question: "99.9% of checkout requests succeed over 30
days" gives an error budget of 0.1%. You page when that budget is burning fast enough to run out, and you never
page for blips the budget can absorb.

```
SLO (objective, error ratio as PromQL)
  → recording rules: error ratio over 5m, 30m, 1h, 6h, 3d
  → alerts:  page    1h > 14.4× budget AND 5m > 14.4×    (2% of the month's budget in an hour)
             page    6h > 6×           AND 30m > 6×        (5% in six hours)
             ticket  3d > 1×           AND 6h > 1×         (10% in three days)
  the short window ends the alert soon after the burn stops
```

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| What gets an SLO | 2–5 user journeys: "checkout succeeds", "chat answers start within 2 s", "jobs start within a minute" | Not per service, not per host. Measure what a user would notice. |
| Objective | 99.9% over 30 days for availability, 99% under a threshold for latency | 99.99% means 4 minutes a month: only if you can actually respond in that time. |
| Latency SLI | The share of requests under a threshold (histogram buckets) | Never an average. p99 is fine for dashboards but awkward for budgets. |
| Routing | `severity=page` to on-call, `ticket` to the team queue | Decide who is on call before shipping the alerts. |
| Backend | Prometheus + Alertmanager (rules generated here) | Grafana, Datadog and Cloud Monitoring have SLO features with the same burn-rate math: use the windows and factors below. |
| Error budget policy | When the budget is spent, reliability work comes before features | Without this, the SLO is just a dashboard. |

## Implementation steps

1. **Define SLOs in code** as `Slo[]` from [references/slo.ts](references/slo.ts): name, service, objective, and the
   error ratio as PromQL with `{{window}}`. For latency, the bad events are the requests above the threshold
   (`le` buckets).
2. **Generate the rules.** `prometheusRules(slos)` returns recording rules for five windows plus the three burn-rate
   alerts. Write them with `JSON.stringify`: JSON is valid YAML. Commit the file. Never edit the generated rules by
   hand.
   It refuses three definitions that would load fine and never alert:
   - an error ratio without `{{window}}`, which gives five identical rules;
   - an objective written as a percentage, `99.9` for `0.999`;
   - an objective below 0.931, where the 14.4× page needs an error ratio above 1, more than every request failing.

   It also refuses two SLOs with the same name. Each SLO is a rule group named after it, and Prometheus rejects a
   file with a group name twice, with every other rule in it: one copied SLO that kept its name switched off all
   alerting.

   For objectives that low (batch jobs, best-effort features), alert on the error ratio directly instead of on burn
   rate.
3. **Test the rules in CI with promtool** (`promtool check rules`, then `promtool test rules` with synthetic
   series). This is what proves the PromQL fires when you think it does.
   [The test](../../verify/tests/skills/slo-alerting.test.ts) runs promtool from the official image.
4. **Check incident sizes before they happen.** `simulate(objective, minutes)` replays per-minute traffic and
   reports when each alert would fire. Use it to check that a realistic incident (say 5% errors) pages in time, and
   that last month's noise wouldn't have.
5. **Wire the kit's signals.** [references/kit-signals.md](references/kit-signals.md) lists one signal per skill:
   job wait time, outbox lag, dead letters, reconciliation misses, limiter degradation, LLM spend anomalies, TTFT,
   erasure deadlines, lock waits.
6. **Alertmanager.** Route by `severity`. Group by `slo`. Inhibit the ticket while a page for the same SLO is
   firing. Put `runbook_url` on every SLO.

## Verification (required)

[verify/tests/skills/slo-alerting.test.ts](../../verify/tests/skills/slo-alerting.test.ts) covers:
- **A 10% error rate on a 99.9% SLO pages within 9 minutes.** The 6-hour page follows at 22 minutes and the ticket
  at 44 (after three quiet days of history).
- **A slow burn (0.2% errors, twice the sustainable rate) never pages**, and opens a ticket after 36 hours.
- Normal noise (0.05% errors) never alerts.
- **promtool on the generated rules:**
  - they are valid, and Prometheus fires both pages within 5 minutes of a 10% error rate, plus the ticket by
    minute 15;
  - 5 minutes after the fix the 1-hour page resolves, and 30 minutes after it the 6-hour page does;
  - the ticket stays open for the follow-up;
  - a healthy hour fires nothing.

How to write these tests so they prove something:
- Test the rules where they run. A unit test of your own burn-rate arithmetic doesn't prove the PromQL is right;
  `promtool test rules` does.
- Include the resolve side: an alert that never clears trains people to ignore it.

## Record the decision
ADR: the SLO list with objectives and owners, windows and factors, routing, error budget policy.

## Common mistakes
- Alerting on causes (CPU, memory, a single failed request) instead of symptoms users feel.
- A static threshold like "error rate > 5% for 5 minutes". It misses a 2% error rate that burns the whole month in
  a day, and pages on a 30-second blip.
- A single window: a long one keeps paging for hours after the fix, and a short one flaps.
- An average latency SLO: one slow endpoint hides behind fast health checks.
- Alerts nobody owns, or with no runbook.
- Copying an SLO definition and keeping its name. Prometheus refuses the whole rule file over the repeated group
  name, so not one alert in it loads.
- SLOs for every service, no journeys: dozens of alerts and none that says "customers can't check out".
