---
name: llm-observability
description: Trace every request end to end — HTTP → DB queries → retrieval → the exact LLM prompt and response → async workers — with OpenTelemetry, exported to Langfuse and/or any tracing backend, so a bad or hallucinated AI answer can be reconstructed and debugged. Use whenever the user adds OpenTelemetry, Langfuse, LangSmith, Helicone, Jaeger/Tempo, asks "why did the bot say that", "debug hallucination", "trace LLM calls", "log prompt", "theo dõi request AI", or ships any feature where an LLM answer depends on retrieved data.
---

# LLM observability: reconstruct what the model saw

You can't debug an AI answer from logs that say `llm call ok 812 tokens`. To explain a hallucination you need the **exact context**: which request, which user and tenant, which chunks were retrieved and at which version, the final prompt (template version plus filled values), parameters, response, tokens and cost. All of it has to sit in **one trace** with the DB queries and HTTP calls around it.

Use OpenTelemetry as the backbone, because it is vendor-neutral and auto-instruments HTTP/pg/redis. Add LLM-specific spans following the GenAI semantic conventions. Send them to Langfuse (LLM-centric UI: prompts, scores, cost) and/or a general backend (Tempo, Jaeger, Honeycomb, Datadog).

## Decision points: ask before coding

| Decision | Default | Notes |
|---|---|---|
| Backend(s) | OTel Collector → Langfuse (LLM spans) + Tempo/Jaeger or the existing APM | Langfuse is self-hostable (Docker: Postgres + ClickHouse + Redis + S3) or Cloud. Ask about data residency. |
| Prompt/response capture | Capture, **redacted** (`pii-redaction`) | Some features may need metadata-only (`captureContent: false`), e.g. health or legal. Decide per feature. |
| Sampling | 100% of LLM traces and errors, ~10% of the rest (tail sampling in the collector) | LLM traces are the expensive ones to lose. |
| Retention | 30 days for content, longer for metrics | Content is sensitive; metrics aren't. |
| Prompt versioning | Name + version on every LLM span | Langfuse prompt management, or prompts in the repo with a version constant. |

## Implementation steps

1. **Bootstrap**: [references/otel-setup.ts](references/otel-setup.ts), loaded with `node --import`, before app code. Auto-instrumentations cover HTTP in/out, `pg`, `ioredis`, `undici`. Export to a collector ([references/collector.yaml](references/collector.yaml)) so apps don't hold vendor keys, and so scrubbing and sampling live in one place. Register `sdk.shutdown()` as a shutdown hook (`service-hardening`) so final spans are flushed.
2. **LLM spans**: wrap every model call in `withLlmSpan(tracer, info, fn, { redact })` from [references/llm-tracing.ts](references/llm-tracing.ts). It records the model, parameters, tenant, feature, prompt name/version, redacted input/output messages, token usage, cost, cache status and finish reason. Errors mark the span and are rethrown. If you use the `llm-gateway`, wrap `gateway.chat`; its result already carries cost, cache and fallback info.
3. **Retrieval spans**: wrap RAG retrieval in `withRetrievalSpan`. It records chunk ids, **document versions** and ranks (`multitenant-postgres` returns `semantic_rank`/`keyword_rank`). "The answer was right for last month's policy doc" is a common root cause, and only versions reveal it.
4. **Async hops**: when work leaves the request (outbox, webhook inbox, queue, cron), call `injectTraceContext()` into the message headers on the producer side, and `runWithTraceContext(headers, …)` in the worker. One user action stays one trace even when the LLM runs minutes later.
5. **Expose the trace id**: return `currentTraceId()` as an `x-trace-id` response header and store it on the `llm_usage` row. Support and FinOps can then jump from a complaint or a cost spike straight to the trace.
6. **Feedback loop** (optional, high value): send user thumbs-up/down or evaluator scores to Langfuse against the trace id, to find bad answers at scale.

## Verification (required)

[verify/tests/llm-observability.test.ts](../../verify/tests/llm-observability.test.ts) uses the real OTel SDK with an in-memory exporter:
- One request produces one trace: retrieval and LLM spans are children of the HTTP span; `currentTraceId()` matches.
- The LLM span carries model, tokens, cost, tenant and prompt version; the prompt includes the retrieved chunk ids; **emails and card numbers are redacted** in input, output and retrieval query (integration with the `pii-redaction` redactor).
- Retrieval span lists `documentId@version` for each chunk.
- `captureContent: false` stores no text but keeps the metrics.
- An error sets status ERROR with an exception event and rethrows.
- Trace context survives an async hop: the consumer span has the producer's trace id and parent span id.

End to end, after wiring the real exporter: send one chat request in staging and confirm in Langfuse/Jaeger that a single trace shows HTTP → SQL → retrieve → chat, with the prompt visible and redacted. Also confirm a queued follow-up job appears in the same trace.

## Record the decision
ADR: backends and collector topology, content capture policy per feature, sampling, retention.

## Common mistakes
- Initializing OTel after importing `pg`/`http`: auto-instrumentation silently does nothing.
- Logging prompts to stdout "for debugging": unredacted, unsampled, unsearchable.
- Recording the prompt template but not the filled values or retrieved chunks: you still can't reproduce the answer.
- Dropping trace context at the queue boundary: the slow, expensive part of the flow becomes an orphan trace.
- No `sdk.shutdown()` on exit: the spans from the crash you're investigating never arrive.
