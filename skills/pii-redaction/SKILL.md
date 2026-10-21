---
name: pii-redaction
description: Strip personal data and secrets (emails, phone numbers, national IDs/CCCD, card numbers, tokens, API keys, passwords) from logs, traces, error reports, audit trails and LLM observability before they are stored. Use whenever the user sets up logging (pino, winston, structlog, zap…), Sentry/error tracking, OpenTelemetry/Langfuse, or audit logs, or mentions GDPR / Nghị định 13 / PDPA / "che thông tin cá nhân", "log bị lộ dữ liệu", "mask PII" — and also when you notice code logging request bodies, headers or user objects.
---

# PII & secret redaction

Logs and traces are copied everywhere: log vendors, laptops, support tickets, LLM context windows. Every PII value in a log is a breach you have already shipped. So redact **at the sink boundary** (logger formatter, span exporter, error-tracker hook), where it applies to every call site, rather than asking each developer to remember.

Use two mechanisms together:
- **Key-based**: values under keys like `password`, `token`, `authorization`, `cookie`, `apiKey` are replaced wholesale. Fast and precise.
- **Pattern-based**: free text is scanned for emails, phones, national IDs, cards (Luhn-checked), JWTs, bearer tokens and API keys. This catches PII that ends up in messages, error strings and LLM prompts.

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Placeholder style | `[EMAIL:3f9a1c]`: short HMAC with a secret key | Lets you see "same user hit this 40 times" without storing the value. Plain `[EMAIL]` if correlation isn't needed. Rotate the key = break correlation; that's fine. |
| Which jurisdictions' formats | VN phone + CCCD + international email/card/tokens | Add detectors for other markets (e.g. US SSN, EU IBAN) as fixtures, not ad hoc. |
| Full prompts in LLM traces? | Store redacted prompts | Debugging hallucinations needs the prompt (see `llm-observability`), but most debugging still works with PII replaced. If full prompts are required, restrict access and retention on that store instead. |
| PII sent *to* the LLM provider | Out of scope by default | That's a separate decision (pseudonymize-and-restore, zero-retention provider). Raise it, don't silently solve it. |
| Retention of raw request bodies | Don't log bodies | Log ids, sizes and shapes instead. |

## Implementation steps

1. Copy [references/redact.ts](references/redact.ts) into the project's shared logging module. It is self-contained: `createRedactor()` → `{ redactString, redactValue }`, plus `pinoRedactionOptions()`. For other languages, port the detector list and the fixture table. The fixtures are the spec.
2. **Wire every sink**:
   - **Logger**: pino → `pino({ ...pinoRedactionOptions(redactor), redact: [known paths] })`. Use `redact` paths for hot, known locations and the formatter for everything else. For winston/structlog/zap, add an equivalent format/processor.
   - **HTTP access logs**: log method, route template, status, duration and request id. Never log raw headers or bodies.
   - **Error tracker**: Sentry `beforeSend` / `beforeBreadcrumb` → `redactValue(event)`.
   - **Traces**: redact attributes when you set them (the `llm-observability` helpers take a redactor), or add a redaction/transform processor in the OTel Collector. Span attributes are immutable after end, so redacting in an exporter is awkward.
   - **Audit logs**: keep actor ids and actions, redact free text.
3. **Seed the fixture table** with the formats your users actually type: with/without separators, `+84`, emails with `+tag`, cards with spaces. Add false-positive guards too: order ids, timestamps, trace ids, version numbers.
4. Add a **CI guard**: one test that runs a realistic log line through the configured logger (not just the redactor) and asserts no raw value appears in the output.

## Verification (required)

[verify/tests/pii-redaction.test.ts](../../verify/tests/pii-redaction.test.ts) is the template:
- Every fixture in "redacts" becomes its placeholder; every fixture in "keeps" is unchanged (Luhn and digit-boundary guards work).
- Sensitive keys are replaced at any depth; arrays, `Error` objects (message **and** stack), cycles and deep nesting are handled without throwing; input objects are not mutated.
- HMAC placeholders are stable for the same value and differ for different values.
- The real logger configuration (pino hooks) redacts both merged objects and message strings.
- **End-to-end**: trigger an error in a request containing an email and a card number, then grep the captured log output and the error-tracker payload. Neither raw value should be present.

## Record the decision
ADR: placeholder style and HMAC key handling, which sinks are covered, prompt-storage policy, retention.

## Common mistakes
- Redacting only `message` and forgetting `err.stack`, which often embeds the input.
- Patterns without boundaries. `\d{12}` eats trace ids and timestamps, and then people turn redaction off.
- Logging `req.body` "temporarily".
- Treating redaction as encryption. It is lossy on purpose; keep raw data in the database under access control, not in logs.
