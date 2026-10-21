// Helpers that make an LLM call reconstructible from its trace: which request triggered it,
// which documents were retrieved, the exact (redacted) prompt, the answer, tokens and cost.
// Uses only @opentelemetry/api — vendor-neutral; Langfuse/Jaeger/Tempo/Honeycomb all read it.
import { context, propagation, SpanKind, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';

/**
 * Attribute names. gen_ai.* follow the OpenTelemetry GenAI semantic conventions (still evolving —
 * both the older `gen_ai.system` and newer `gen_ai.provider.name` are set). The langfuse.* keys are
 * Langfuse's OTel property mapping; check them against your Langfuse version's docs.
 */
export const ATTR = {
  operation: 'gen_ai.operation.name',
  system: 'gen_ai.system',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  temperature: 'gen_ai.request.temperature',
  maxTokens: 'gen_ai.request.max_tokens',
  responseModel: 'gen_ai.response.model',
  finishReasons: 'gen_ai.response.finish_reasons',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  lfInput: 'langfuse.observation.input',
  lfOutput: 'langfuse.observation.output',
  lfUserId: 'langfuse.user.id',
  lfSessionId: 'langfuse.session.id',
  tenantId: 'app.tenant_id',
  feature: 'app.feature',
  costUsd: 'app.llm.cost_usd',
  cache: 'app.llm.cache',
  promptName: 'app.prompt.name',
  promptVersion: 'app.prompt.version',
  retrievalQuery: 'app.retrieval.query',
  retrievalDocs: 'app.retrieval.documents',
  retrievalCount: 'app.retrieval.count',
} as const;

export interface TraceMessage {
  role: string;
  content: string;
}

export interface LlmCallInfo {
  provider: string; // 'anthropic', 'openai', 'gateway'
  model: string;
  messages: TraceMessage[];
  temperature?: number;
  maxTokens?: number;
  tenantId: string;
  userId?: string; // pass a pseudonymous id, not an email
  sessionId?: string;
  feature?: string;
  /** Version the prompt template — "which prompt produced this?" is the first debugging question. */
  promptName?: string;
  promptVersion?: string;
}

export interface LlmCallResult {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
  responseModel?: string;
  finishReason?: string;
  costUsd?: number;
  cache?: string;
}

export interface ContentOptions {
  /** false = metadata only (tokens, model, cost) — for features whose prompts may not be stored at all. */
  captureContent?: boolean; // default true
  /** Apply PII redaction before content leaves the process (see pii-redaction skill). */
  redact?: (s: string) => string;
}

function contentJson(messages: TraceMessage[], redact?: (s: string) => string) {
  return JSON.stringify(messages.map((m) => ({ role: m.role, content: redact ? redact(m.content) : m.content })));
}

/** Wrap one model call. Creates a CLIENT span as a child of whatever is active (HTTP request, job). */
export async function withLlmSpan<T extends LlmCallResult>(
  tracer: Tracer,
  info: LlmCallInfo,
  fn: (span: Span) => Promise<T>,
  opts: ContentOptions = {},
): Promise<T> {
  const capture = opts.captureContent ?? true;
  return tracer.startActiveSpan(`chat ${info.model}`, { kind: SpanKind.CLIENT }, async (span) => {
    span.setAttributes({
      [ATTR.operation]: 'chat',
      [ATTR.system]: info.provider,
      [ATTR.providerName]: info.provider,
      [ATTR.requestModel]: info.model,
      [ATTR.tenantId]: info.tenantId,
      ...(info.temperature !== undefined && { [ATTR.temperature]: info.temperature }),
      ...(info.maxTokens !== undefined && { [ATTR.maxTokens]: info.maxTokens }),
      ...(info.feature && { [ATTR.feature]: info.feature }),
      ...(info.userId && { [ATTR.lfUserId]: info.userId }),
      ...(info.sessionId && { [ATTR.lfSessionId]: info.sessionId }),
      ...(info.promptName && { [ATTR.promptName]: info.promptName }),
      ...(info.promptVersion && { [ATTR.promptVersion]: info.promptVersion }),
    });
    if (capture) {
      const input = contentJson(info.messages, opts.redact);
      span.setAttribute(ATTR.inputMessages, input);
      span.setAttribute(ATTR.lfInput, input);
    }
    try {
      const result = await fn(span);
      if (result.usage) {
        span.setAttribute(ATTR.inputTokens, result.usage.inputTokens);
        span.setAttribute(ATTR.outputTokens, result.usage.outputTokens);
      }
      if (result.responseModel) span.setAttribute(ATTR.responseModel, result.responseModel);
      if (result.finishReason) span.setAttribute(ATTR.finishReasons, [result.finishReason]);
      if (result.costUsd !== undefined) span.setAttribute(ATTR.costUsd, result.costUsd);
      if (result.cache) span.setAttribute(ATTR.cache, result.cache);
      if (capture) {
        const output = contentJson([{ role: 'assistant', content: result.content }], opts.redact);
        span.setAttribute(ATTR.outputMessages, output);
        span.setAttribute(ATTR.lfOutput, output);
      }
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface RetrievedDoc {
  id: string;
  documentId?: string;
  /** Document version/hash: without it you can't tell whether the answer came from stale content. */
  version?: string | number;
  score?: number;
  rank?: number;
}

/** Wrap retrieval (RAG). Records which chunks — ids, versions, ranks — went into the prompt. */
export async function withRetrievalSpan<T extends RetrievedDoc[]>(
  tracer: Tracer,
  query: string,
  fn: () => Promise<T>,
  opts: { redact?: (s: string) => string } = {},
): Promise<T> {
  return tracer.startActiveSpan('retrieve', async (span) => {
    span.setAttribute(ATTR.retrievalQuery, opts.redact ? opts.redact(query) : query);
    try {
      const docs = await fn();
      span.setAttribute(ATTR.retrievalCount, docs.length);
      span.setAttribute(
        ATTR.retrievalDocs,
        JSON.stringify(docs.map((d) => ({ id: d.id, documentId: d.documentId, version: d.version, score: d.score, rank: d.rank }))),
      );
      return docs;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Producer side of async work (outbox, webhook inbox, queue): store the result in message headers. */
export function injectTraceContext(carrier: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Consumer side: run the handler inside the producer's trace so the whole flow is one trace. */
export function runWithTraceContext<T>(carrier: Record<string, string> | undefined, fn: () => T): T {
  return context.with(propagation.extract(context.active(), carrier ?? {}), fn);
}

/** Return this to clients (e.g. `x-trace-id` header) so support can jump straight to the trace. */
export function currentTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}
