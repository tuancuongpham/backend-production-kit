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
  captureError: 'app.trace.capture_error',
} as const;

export interface TraceMessage {
  role: string;
  /** Text, or SDK content parts (serialized before redaction, so the redactor sees their text too). */
  content: string | unknown[] | null;
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
  /** null when the model answered with tool calls only. */
  content: string | null;
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
  /**
   * Cap per content attribute (default 32 KiB). RAG prompts reach hundreds of KB; spans that size can
   * exceed exporter or backend request limits, and a rejected export drops the whole batch, other
   * requests' spans included.
   */
  maxContentChars?: number;
}

const DEFAULT_MAX_CONTENT = 32 * 1024;

function bounded(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}…[TRUNCATED ${s.length - max} chars]` : s;
}

function contentJson(messages: TraceMessage[], redact: ((s: string) => string) | undefined, max: number) {
  const render = (content: TraceMessage['content']) => {
    if (content === null || content === undefined) return null;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    return redact ? redact(text) : text;
  };
  return bounded(JSON.stringify(messages.map((m) => ({ role: m.role, content: render(m.content) }))), max);
}

/**
 * Instrumentation must never fail the call it observes. If recording throws (a custom redactor, an odd result
 * from an SDK), the span loses that piece and says why; the model call and its answer are untouched.
 */
function safely(span: Span, what: string, record: () => void) {
  try {
    record();
  } catch (err) {
    span.setAttribute(ATTR.captureError, `${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Wrap one model call. Creates a CLIENT span as a child of whatever is active (HTTP request, job). */
export async function withLlmSpan<T extends LlmCallResult>(
  tracer: Tracer,
  info: LlmCallInfo,
  fn: (span: Span) => Promise<T>,
  opts: ContentOptions = {},
): Promise<T> {
  const capture = opts.captureContent ?? true;
  const max = opts.maxContentChars ?? DEFAULT_MAX_CONTENT;
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
      safely(span, 'input', () => {
        const input = contentJson(info.messages, opts.redact, max);
        span.setAttribute(ATTR.inputMessages, input);
        span.setAttribute(ATTR.lfInput, input);
      });
    }
    try {
      const result = await fn(span);
      safely(span, 'output', () => {
        if (result.usage) {
          span.setAttribute(ATTR.inputTokens, result.usage.inputTokens);
          span.setAttribute(ATTR.outputTokens, result.usage.outputTokens);
        }
        if (result.responseModel) span.setAttribute(ATTR.responseModel, result.responseModel);
        if (result.finishReason) span.setAttribute(ATTR.finishReasons, [result.finishReason]);
        if (result.costUsd !== undefined) span.setAttribute(ATTR.costUsd, result.costUsd);
        if (result.cache) span.setAttribute(ATTR.cache, result.cache);
        if (capture) {
          const output = contentJson([{ role: 'assistant', content: result.content }], opts.redact, max);
          span.setAttribute(ATTR.outputMessages, output);
          span.setAttribute(ATTR.lfOutput, output);
        }
      });
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
  opts: { redact?: (s: string) => string; maxContentChars?: number } = {},
): Promise<T> {
  const max = opts.maxContentChars ?? DEFAULT_MAX_CONTENT;
  return tracer.startActiveSpan('retrieve', async (span) => {
    safely(span, 'query', () => span.setAttribute(ATTR.retrievalQuery, bounded(opts.redact ? opts.redact(query) : query, max)));
    try {
      const docs = await fn();
      safely(span, 'documents', () => {
        span.setAttribute(ATTR.retrievalCount, docs.length);
        span.setAttribute(
          ATTR.retrievalDocs,
          bounded(JSON.stringify(docs.map((d) => ({ id: d.id, documentId: d.documentId, version: d.version, score: d.score, rank: d.rank }))), max),
        );
      });
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
