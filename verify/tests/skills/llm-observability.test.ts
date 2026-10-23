import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ATTR,
  currentTraceId,
  injectTraceContext,
  runWithTraceContext,
  withLlmSpan,
  withRetrievalSpan,
} from '../../../skills/llm-observability/references/llm-tracing.ts';
import { createRedactor } from '../../../skills/pii-redaction/references/redact.ts';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('kit-test');
const redactor = createRedactor();

const span = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name)!;
const parentId = (s: any) => s.parentSpanContext?.spanId ?? s.parentSpanId;

describe('llm-observability', () => {
  before(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(provider);
  });
  after(async () => {
    await provider.shutdown();
    context.disable();
    propagation.disable();
    trace.disable();
  });
  beforeEach(() => exporter.reset());

  it('one request → one trace: HTTP span ⊃ retrieval span + LLM span with full, redacted context', async () => {
    let traceIdInHandler: string | undefined;
    await tracer.startActiveSpan('POST /chat', async (http) => {
      traceIdInHandler = currentTraceId();
      const docs = await withRetrievalSpan(tracer, 'refund for alice@example.com', async () => [
        { id: 'c1', documentId: 'd1', version: 3, rank: 1, score: 0.031 },
        { id: 'c7', documentId: 'd2', version: 1, rank: 2, score: 0.016 },
      ], { redact: redactor.redactString });
      await withLlmSpan(
        tracer,
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          temperature: 0,
          tenantId: 't-42',
          userId: 'u-9f2c',
          feature: 'support-chat',
          promptName: 'support-answer',
          promptVersion: 'v7',
          messages: [
            { role: 'system', content: `Answer using: ${docs.map((d) => d.id).join(',')}` },
            { role: 'user', content: 'I am alice@example.com, card 4111 1111 1111 1111 — refund please' },
          ],
        },
        async () => ({ content: 'Refund issued to alice@example.com', usage: { inputTokens: 812, outputTokens: 64 }, costUsd: 0.0034, finishReason: 'end_turn' }),
        { redact: redactor.redactString },
      );
      http.end();
    });

    const httpSpan = span('POST /chat');
    const retrieval = span('retrieve');
    const llm = span('chat claude-sonnet-5-5');
    const traceId = httpSpan.spanContext().traceId;
    assert.equal(traceIdInHandler, traceId);
    for (const s of [retrieval, llm]) {
      assert.equal(s.spanContext().traceId, traceId, `${s.name} in same trace`);
      assert.equal(parentId(s), httpSpan.spanContext().spanId, `${s.name} child of the HTTP span`);
    }

    assert.equal(llm.attributes[ATTR.requestModel], 'claude-sonnet-5-5');
    assert.equal(llm.attributes[ATTR.inputTokens], 812);
    assert.equal(llm.attributes[ATTR.outputTokens], 64);
    assert.equal(llm.attributes[ATTR.costUsd], 0.0034);
    assert.equal(llm.attributes[ATTR.tenantId], 't-42');
    assert.equal(llm.attributes[ATTR.promptVersion], 'v7');
    const input = String(llm.attributes[ATTR.inputMessages]);
    assert.ok(input.includes('Answer using: c1,c7'), 'prompt captured');
    assert.ok(input.includes('[EMAIL]') && input.includes('[CARD]'), 'PII redacted');
    assert.ok(!input.includes('alice@') && !String(llm.attributes[ATTR.outputMessages]).includes('alice@'));
    assert.equal(retrieval.attributes[ATTR.retrievalQuery], 'refund for [EMAIL]');
    assert.deepEqual(JSON.parse(String(retrieval.attributes[ATTR.retrievalDocs])).map((d: any) => `${d.documentId}@v${d.version}`), ['d1@v3', 'd2@v1']);
  });

  it('metadata-only mode stores no prompt or completion text', async () => {
    await withLlmSpan(tracer, { provider: 'openai', model: 'm', tenantId: 't', messages: [{ role: 'user', content: 'secret' }] },
      async () => ({ content: 'answer', usage: { inputTokens: 1, outputTokens: 1 } }), { captureContent: false });
    const s = span('chat m');
    assert.equal(s.attributes[ATTR.inputMessages], undefined);
    assert.equal(s.attributes[ATTR.outputMessages], undefined);
    assert.equal(s.attributes[ATTR.inputTokens], 1);
  });

  it('errors mark the span and are rethrown', async () => {
    await assert.rejects(
      withLlmSpan(tracer, { provider: 'openai', model: 'm', tenantId: 't', messages: [] }, async () => { throw new Error('529 overloaded'); }),
      /529/,
    );
    const s = span('chat m');
    assert.equal(s.status.code, 2); // ERROR
    assert.ok(s.events.some((e) => e.name === 'exception'));
  });

  it('a failure that is not an Error is recorded as text; a redactor that throws loses the text, not the failure', async () => {
    await assert.rejects(
      withLlmSpan(
        tracer,
        { provider: 'openai', model: 'm2', tenantId: 't', messages: [] },
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test: an SDK that rejects with a string
        async () => Promise.reject('upstream said no to lan@shop.vn'),
        { redact: redactor.redactString },
      ),
    );
    assert.deepEqual(span('chat m2').status, { code: 2, message: 'upstream said no to [EMAIL]' });
    await assert.rejects(
      withLlmSpan(tracer, { provider: 'openai', model: 'm3', tenantId: 't', messages: [] }, async () => { throw new Error('quota of lan@shop.vn'); }, {
        captureContent: false,
        redact: () => {
          throw new Error('redactor bug');
        },
      }),
      /quota/,
    );
    const failed = span('chat m3');
    assert.equal(failed.status.code, 2);
    assert.ok(!JSON.stringify(failed.events).includes('lan@shop.vn'));
  });

  it('a failed retrieval marks its span too, and the error reaches the caller', async () => {
    await assert.rejects(withRetrievalSpan(tracer, 'chính sách đổi trả', async () => Promise.reject(new Error('vector index offline'))), /offline/);
    const s = exporter.getFinishedSpans().filter((x) => x.name === 'retrieve').at(-1)!;
    assert.equal(s.status.code, 2); // ERROR
    assert.ok(s.events.some((e) => e.name === 'exception'));
  });

  it('trace context survives an async hop (outbox / queue / webhook inbox)', async () => {
    let headers: Record<string, string> = {};
    let producerSpanId = '';
    await tracer.startActiveSpan('POST /orders', async (s) => {
      producerSpanId = s.spanContext().spanId;
      headers = injectTraceContext({ 'content-type': 'json' }); // stored with the message
      s.end();
    });
    assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    // ...later, in a worker process:
    await runWithTraceContext(headers, () =>
      tracer.startActiveSpan('process order.placed', async (s) => {
        s.end();
      }),
    );
    const producer = span('POST /orders');
    const consumer = span('process order.placed');
    assert.equal(consumer.spanContext().traceId, producer.spanContext().traceId);
    assert.equal(parentId(consumer), producerSpanId);
  });
});
