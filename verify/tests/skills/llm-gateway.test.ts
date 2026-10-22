import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AllProvidersFailedError,
  BudgetExceededError,
  createGateway,
  memoryBudget,
  memoryCache,
  ProviderError,
  type ChatRequest,
  type Provider,
  type UsageRecord,
} from '../../../skills/llm-gateway/references/gateway.ts';

const prices = {
  'big-model': { inputPer1M: 3, outputPer1M: 15 },
  'small-model': { inputPer1M: 0.25, outputPer1M: 1.25 },
};

function fakeProvider(name: string, model: string, behaviour: (n: number) => 'ok' | number | 'hang' = () => 'ok') {
  let calls = 0;
  const p: Provider & { calls: () => number } = {
    name,
    model,
    calls: () => calls,
    async complete(req, signal) {
      const b = behaviour(++calls);
      if (b === 'hang') {
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      if (typeof b === 'number') throw new ProviderError(`${name} HTTP ${b}`, { status: b });
      const q = req.messages.at(-1)!.content;
      return { content: `${name} answer to: ${q}`, usage: { inputTokens: 1000, outputTokens: 500 } };
    },
  };
  return p;
}

// Stand-in embedder with controlled geometry: paraphrases point the same way, the negation doesn't.
const vectors: Record<string, number[]> = {
  'How do I get a refund?': [1, 0.02, 0],
  'how can i get my money back': [0.98, 0.05, 0.01], // cosine ≈ 0.999
  "Please don't refund my order": [0.55, 0.83, 0], // cosine ≈ 0.55 — different meaning
};
const embed = async (t: string) => vectors[t] ?? [0, 0, 1];

const ask = (q: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'system', content: 'You are a support bot.' }, { role: 'user', content: q }],
  temperature: 0,
  ...extra,
});

describe('llm-gateway', () => {
  it('exact cache: identical request hits cache, provider called once, cost 0 on hit', async () => {
    const primary = fakeProvider('anthropic', 'big-model');
    const usage: UsageRecord[] = [];
    const gw = createGateway({ providers: [primary], prices, cache: memoryCache(), onUsage: (u) => void usage.push(u) });
    const a = await gw.chat(ask('Where is my order?'), { tenantId: 't1' });
    const b = await gw.chat(ask('Where is my order?'), { tenantId: 't1' });
    assert.equal(a.cache, 'miss');
    assert.equal(b.cache, 'exact');
    assert.equal(b.content, a.content);
    assert.equal(primary.calls(), 1);
    assert.deepEqual(usage.map((u) => [u.cache, u.costUsd]), [['miss', 0.0105], ['exact', 0]]);
  });

  it('semantic cache (serve mode): paraphrase hits, negation misses', async () => {
    const primary = fakeProvider('anthropic', 'big-model');
    const gw = createGateway({ providers: [primary], prices, cache: memoryCache(), embed, semanticMode: 'serve', semanticThreshold: 0.95 });
    await gw.chat(ask('How do I get a refund?'), { tenantId: 't1' });
    const para = await gw.chat(ask('how can i get my money back'), { tenantId: 't1' });
    assert.equal(para.cache, 'semantic');
    assert.ok((para as any).similarity > 0.99);
    const neg = await gw.chat(ask("Please don't refund my order"), { tenantId: 't1' });
    assert.equal(neg.cache, 'miss');
    assert.equal(primary.calls(), 2);
  });

  it('semantic cache defaults to shadow: reports would-be hits for labelling but still calls the model', async () => {
    const primary = fakeProvider('anthropic', 'big-model');
    const shadow: any[] = [];
    const gw = createGateway({ providers: [primary], prices, cache: memoryCache(), embed, onShadowHit: (h) => shadow.push(h) });
    await gw.chat(ask('How do I get a refund?'), { tenantId: 't1' });
    const r = await gw.chat(ask('how can i get my money back'), { tenantId: 't1' });
    assert.equal(r.cache, 'miss');
    assert.equal(primary.calls(), 2);
    assert.equal(shadow.length, 1);
    assert.equal(shadow[0].question, 'how can i get my money back');
    assert.equal(shadow[0].cachedQuestion, 'How do I get a refund?');
    assert.ok(shadow[0].similarity > 0.99);
  });

  it('an embedding provider that fails only costs the semantic cache: the request is answered, the failure reported', async () => {
    const stages: string[] = [];
    const gw = createGateway({
      providers: [fakeProvider('anthropic', 'big-model')],
      prices,
      cache: memoryCache(),
      embed: async () => Promise.reject(new Error('embeddings 503')),
      semanticMode: 'serve',
      onError: (_err, stage) => void stages.push(stage),
    });
    const r = await gw.chat(ask('How do I get a refund?'), { tenantId: 't1' });
    assert.deepEqual([r.content, r.cache, stages], ['anthropic answer to: How do I get a refund?', 'miss', ['embed']]);
  });

  it('an async onShadowHit that rejects is reported to onError, never left as an unhandled rejection', async () => {
    const stages: string[] = [];
    const primary = fakeProvider('anthropic', 'big-model');
    const gw = createGateway({
      providers: [primary],
      prices,
      cache: memoryCache(),
      embed,
      onShadowHit: async () => Promise.reject(new Error('labelling queue down')),
      onError: (_err, stage) => void stages.push(stage),
    });
    await gw.chat(ask('How do I get a refund?'), { tenantId: 't1' });
    await gw.chat(ask('how can i get my money back'), { tenantId: 't1' }); // a would-be semantic hit
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(stages, ['cache-read']);
  });

  it('cache never crosses tenants or system prompts (exact and semantic)', async () => {
    const primary = fakeProvider('anthropic', 'big-model');
    const gw = createGateway({ providers: [primary], prices, cache: memoryCache(), embed, semanticMode: 'serve' });
    await gw.chat(ask('How do I get a refund?'), { tenantId: 't1' });
    assert.equal((await gw.chat(ask('How do I get a refund?'), { tenantId: 't2' })).cache, 'miss');
    assert.equal((await gw.chat(ask('how can i get my money back'), { tenantId: 't3' })).cache, 'miss', 'paraphrase in another tenant');
    const otherPrompt: ChatRequest = { messages: [{ role: 'system', content: 'You are a sales bot.' }, { role: 'user', content: 'How do I get a refund?' }] };
    assert.equal((await gw.chat(otherPrompt, { tenantId: 't1' })).cache, 'miss');
  });

  it('non-deterministic, tool-using, opted-out and multi-turn requests bypass or skip semantic cache', async () => {
    const primary = fakeProvider('anthropic', 'big-model');
    const gw = createGateway({ providers: [primary], prices, cache: memoryCache(), embed });
    for (const extra of [{ temperature: 0.7 }, { tools: [{ name: 'lookup' }] }, { cache: false }]) {
      await gw.chat(ask('How do I get a refund?', extra), { tenantId: 't1' });
      assert.equal((await gw.chat(ask('How do I get a refund?', extra), { tenantId: 't1' })).cache, 'bypass');
    }
    // Multi-turn: exact cache still fine, but no semantic matching (history changes meaning).
    const multi = (q: string): ChatRequest => ({
      messages: [{ role: 'user', content: 'I bought shoes' }, { role: 'assistant', content: 'Great!' }, { role: 'user', content: q }],
    });
    await gw.chat(multi('How do I get a refund?'), { tenantId: 't1' });
    assert.equal((await gw.chat(multi('how can i get my money back'), { tenantId: 't1' })).cache, 'miss');
  });

  it('falls back to the next provider on 503 and reports it', async () => {
    const primary = fakeProvider('anthropic', 'big-model', () => 503);
    const backup = fakeProvider('cheap', 'small-model');
    const gw = createGateway({ providers: [primary, backup], prices });
    const r = await gw.chat(ask('hi'), { tenantId: 't1' });
    assert.equal(r.provider, 'cheap');
    assert.deepEqual(r.fallbackFrom, ['anthropic']);
    assert.equal(r.costUsd, (1000 * 0.25 + 500 * 1.25) / 1e6);
  });

  it('falls back on timeout', async () => {
    const primary = fakeProvider('anthropic', 'big-model', () => 'hang');
    const backup = fakeProvider('cheap', 'small-model');
    const gw = createGateway({ providers: [primary, backup], prices, timeoutMs: 100 });
    const t0 = performance.now();
    const r = await gw.chat(ask('hi'), { tenantId: 't1' });
    assert.equal(r.provider, 'cheap');
    assert.ok(performance.now() - t0 < 1000);
  });

  it('does not fall back on a 400 (our bug, same everywhere)', async () => {
    const primary = fakeProvider('anthropic', 'big-model', () => 400);
    const backup = fakeProvider('cheap', 'small-model');
    const gw = createGateway({ providers: [primary, backup], prices });
    await assert.rejects(gw.chat(ask('hi'), { tenantId: 't1' }), ProviderError);
    assert.equal(backup.calls(), 0);
  });

  it('circuit breaker skips a failing provider after the threshold', async () => {
    const primary = fakeProvider('anthropic', 'big-model', () => 503);
    const backup = fakeProvider('cheap', 'small-model');
    const gw = createGateway({ providers: [primary, backup], prices, breaker: { threshold: 2, cooldownMs: 60_000 } });
    for (let i = 0; i < 5; i++) await gw.chat(ask(`q${i}`), { tenantId: 't1' });
    assert.equal(primary.calls(), 2);
    assert.equal(backup.calls(), 5);
  });

  it('all providers down → typed error', async () => {
    const gw = createGateway({ providers: [fakeProvider('a', 'big-model', () => 503), fakeProvider('b', 'small-model', () => 529)], prices });
    await assert.rejects(gw.chat(ask('hi'), { tenantId: 't1' }), AllProvidersFailedError);
  });

  it('budget: once a tenant would exceed its monthly limit, requests are refused without calling a provider', async () => {
    const primary = fakeProvider('anthropic', 'big-model');
    const usage: UsageRecord[] = [];
    const gw = createGateway({
      providers: [primary],
      prices,
      // Each call reserves ≈ $0.0155 (pessimistic estimate) and settles at $0.0105 (actual).
      budget: { store: memoryBudget(), monthlyLimitUsd: (t) => (t === 'free' ? 0.03 : 100) },
      onUsage: (u) => void usage.push(u),
    });
    await gw.chat(ask('q1'), { tenantId: 'free' }); // spent 0.0105
    await gw.chat(ask('q2'), { tenantId: 'free' }); // spent 0.021
    await assert.rejects(gw.chat(ask('q3'), { tenantId: 'free' }), BudgetExceededError); // 0.021 + 0.0155 > 0.03
    assert.equal(primary.calls(), 2);
    await gw.chat(ask('q3'), { tenantId: 'pro' }); // other tenants unaffected
    assert.equal(usage.at(-2)!.error, 'budget exceeded');
  });

  it('budget: concurrent requests cannot push a tenant past its limit (atomic reservation)', async () => {
    const store = memoryBudget();
    let calls = 0;
    const slow: Provider = {
      name: 'p',
      model: 'unit',
      async complete() {
        calls++;
        await new Promise((r) => setTimeout(r, 30)); // all requests are in flight together
        return { content: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 0 } }; // $1
      },
    };
    const gw = createGateway({
      providers: [slow],
      prices: { unit: { inputPer1M: 1, outputPer1M: 0 } },
      budget: { store, monthlyLimitUsd: () => 3, estimateUsd: () => 1 },
    });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => gw.chat(ask(`q${i}`), { tenantId: 't' })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r: any) => r.reason instanceof BudgetExceededError));
    assert.equal(calls, 3, 'refused requests never reached the provider');
    const period = new Date().toISOString().slice(0, 7);
    assert.deepEqual(store.snapshot('t', period), { spent: 3, reserved: 0 });
  });

  it('budget: a failed call releases its reservation', async () => {
    const store = memoryBudget();
    const gw = createGateway({
      providers: [fakeProvider('a', 'big-model', () => 503)],
      prices,
      budget: { store, monthlyLimitUsd: () => 1 },
    });
    await assert.rejects(gw.chat(ask('hi'), { tenantId: 't' }), AllProvidersFailedError);
    assert.deepEqual(store.snapshot('t', new Date().toISOString().slice(0, 7)), { spent: 0, reserved: 0 });
  });

  it('budget: cache hits are still served to a tenant that is out of budget (they cost nothing)', async () => {
    const primary = fakeProvider('anthropic', 'big-model');
    const gw = createGateway({ providers: [primary], prices, cache: memoryCache(), budget: { store: memoryBudget(), monthlyLimitUsd: () => 0.02 } });
    await gw.chat(ask('Where is my order?'), { tenantId: 't' }); // spends 0.0105; next reservation would exceed
    await assert.rejects(gw.chat(ask('something new'), { tenantId: 't' }), BudgetExceededError);
    assert.equal((await gw.chat(ask('Where is my order?'), { tenantId: 't' })).cache, 'exact');
  });

  it('a failing usage sink (sync throw or async rejection) never fails the request', async () => {
    const errors: unknown[] = [];
    for (const onUsage of [() => { throw new Error('ledger down'); }, () => Promise.reject(new Error('ledger down'))]) {
      const gw = createGateway({ providers: [fakeProvider('a', 'big-model')], prices, onUsage, onUsageError: (e) => errors.push(e) });
      assert.equal((await gw.chat(ask('hi'), { tenantId: 't' })).provider, 'a');
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 2);
  });

  it('caller cancellation stops the chain instead of falling back', async () => {
    const primary = fakeProvider('anthropic', 'big-model', () => 'hang');
    const backup = fakeProvider('cheap', 'small-model');
    const gw = createGateway({ providers: [primary, backup], prices });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(gw.chat(ask('hi'), { tenantId: 't1', signal: ac.signal }));
    assert.equal(backup.calls(), 0);
  });
});
