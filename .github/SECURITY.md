# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. You will get an answer within a few days.

Useful details: which skill or reference file, what an attacker could do with code built from it, and steps to
reproduce (ideally a failing test in `verify/tests`).

## Supported versions

Fixes go into the latest version on `main` only.

## Scope

Several skills exist *to prevent* security problems — agent database access (`agent-safe-db`), PII redaction
(`pii-redaction`), tenant isolation (`multitenant-postgres`), webhook signature checks (`webhook-ingestion`).
A gap in their guidance or reference code (for example a bypass of the agent role's permissions, a tenant leak
in the RLS setup, or a PII pattern that slips through) counts as a security issue: please report it privately.

## How the kit handles your data

- The kit is instructions plus reference code. It contains no telemetry and sends nothing anywhere.
- The verification tests start throwaway Postgres and Redis containers locally (`npm run verify:up`) with
  fixed test passwords on non-default ports. Do not reuse those credentials or that compose file in production.
