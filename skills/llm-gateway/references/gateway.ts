// Provider-agnostic LLM gateway core: budget check → exact cache → semantic cache →
// provider chain with timeout + circuit breaker + fallback → cost accounting.
// Plug real providers in via the `Provider` interface (Anthropic/OpenAI SDKs, AI SDK,
// or an upstream gateway such as LiteLLM / Vercel AI Gateway).
import { createHash } from 'node:crypto';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  /** Caller opt-out, e.g. for requests that depend on live data. */
  cache?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface Completion {
  content: string;
  usage: Usage;
}

export interface Provider {
  name: string;
  model: string;
  complete(req: ChatRequest, signal: AbortSignal): Promise<Completion>;
}

/** Throw this from providers. `retryable` decides whether the next provider is tried. */
export class ProviderError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    // 408/409/429/5xx and network failures are worth a fallback; 400/401/403/404 are our bug.
    this.retryable = opts.retryable ?? (opts.status === undefined || opts.status === 408 || opts.status === 409 || opts.status === 429 || opts.status >= 500);
  }
}

export class BudgetExceededError extends Error {}
export class AllProvidersFailedError extends Error {
  errors: unknown[];
  constructor(errors: unknown[]) {
    super(`all providers failed: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`);
    this.errors = errors;
  }
}

export interface CachedResponse {
  content: string;
  model: string;
  provider: string;
  /** The question that produced this entry (semantic cache): needed to label shadow hits. */
  question?: string;
}

export interface CacheStore {
  getExact(key: string): Promise<CachedResponse | null>;
  setExact(key: string, value: CachedResponse, ttlSec: number): Promise<void>;
  findSimilar(scope: string, embedding: number[], minSimilarity: number): Promise<{ value: CachedResponse; similarity: number } | null>;
  saveSimilar(scope: string, embedding: number[], value: CachedResponse, ttlSec: number): Promise<void>;
}

/**
 * Reserve-then-settle budget. A read-then-call check lets N concurrent requests all see
 * "under the limit" and overshoot by N × cost; an atomic reservation can't.
 */
export interface BudgetStore {
  /** Atomically reserve `usd` if spent + reserved + usd ≤ limitUsd. Returns false and reserves nothing otherwise. */
  reserve(tenantId: string, period: string, usd: number, limitUsd: number): Promise<boolean>;
  /** Release the reservation and book the actual cost (0 when the call failed). */
  settle(tenantId: string, period: string, reservedUsd: number, actualUsd: number): Promise<void>;
}

export interface ShadowHit {
  tenantId: string;
  question: string;
  cachedQuestion?: string;
  similarity: number;
}

export interface UsageRecord {
  tenantId: string;
  userId?: string;
  feature?: string;
  provider: string | null;
  model: string | null;
  cache: 'exact' | 'semantic' | 'miss' | 'bypass';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  fallbackFrom: string[];
  ok: boolean;
  error?: string;
}

/** USD per 1M tokens. Load from config — prices change; never hardcode them in business logic. */
export type PriceTable = Record<string, { inputPer1M: number; outputPer1M: number }>;

export interface GatewayOptions {
  /** Primary first, then fallbacks (typically a cheaper/other-vendor model). */
  providers: Provider[];
  prices: PriceTable;
  cache?: CacheStore;
  /** Needed for the semantic cache. Embedding calls cost money too — count them in your FinOps. */
  embed?: (text: string) => Promise<number[]>;
  /**
   * 'shadow' (default): look up similar entries and report them via onShadowHit, but still call the
   * model — collects labelled pairs to tune the threshold. 'serve' only after that eval passes.
   */
  semanticMode?: 'off' | 'shadow' | 'serve';
  semanticThreshold?: number; // cosine similarity, default 0.95
  onShadowHit?: (h: ShadowHit) => void;
  cacheTtlSec?: number; // default 24h
  budget?: {
    store: BudgetStore;
    monthlyLimitUsd: (tenantId: string) => number | Promise<number>;
    /** Upper-bound cost of a request, reserved before the call. Default: chars/4 input + maxTokens output at the priciest model in the chain. */
    estimateUsd?: (req: ChatRequest) => number;
  };
  /** Accounting must never fail the user's request: errors (sync or async) are swallowed and passed to onUsageError. */
  onUsage?: (u: UsageRecord) => void | Promise<unknown>;
  onUsageError?: (err: unknown) => void;
  timeoutMs?: number; // per provider attempt, default 60s
  breaker?: { threshold: number; cooldownMs: number }; // default 3 failures → 30s
  now?: () => number;
}

export interface CallContext {
  tenantId: string;
  userId?: string;
  feature?: string;
  signal?: AbortSignal;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function costUsd(prices: PriceTable, model: string, u: Usage): number {
  const p = prices[model];
  if (!p) return 0; // surface missing prices via a metric/alert rather than failing the request
  return (u.inputTokens * p.inputPer1M + u.outputTokens * p.outputPer1M) / 1_000_000;
}

/** Deliberately pessimistic: a reservation that's too small lets concurrent requests overshoot. */
export function defaultEstimateUsd(prices: PriceTable, models: string[], req: ChatRequest): number {
  const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.ceil(chars / 4) + 50;
  const outputTokens = req.maxTokens ?? 1024;
  return Math.max(0, ...models.map((m) => costUsd(prices, m, { inputTokens, outputTokens })));
}

export function createGateway(o: GatewayOptions) {
  const now = o.now ?? Date.now;
  const semanticMode = o.semanticMode ?? 'shadow';
  const threshold = o.semanticThreshold ?? 0.95;
  const ttl = o.cacheTtlSec ?? 86_400;
  const breakerCfg = o.breaker ?? { threshold: 3, cooldownMs: 30_000 };
  const breakers = new Map<string, { failures: number; openUntil: number }>();

  const period = () => new Date(now()).toISOString().slice(0, 7); // 'YYYY-MM'

  function cacheMode(req: ChatRequest): 'eligible' | 'bypass' {
    // Only deterministic, tool-free requests are safe to serve from cache.
    if (req.cache === false || (req.temperature ?? 0) > 0 || (req.tools?.length ?? 0) > 0) return 'bypass';
    return 'eligible';
  }

  /** Scope = tenant + model route + system prompt: a cached answer never crosses those lines. */
  function scopeOf(ctx: CallContext, req: ChatRequest) {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    return sha256(JSON.stringify([ctx.tenantId, o.providers.map((p) => p.model), system]));
  }

  /** Semantic matching only for single-question requests; in multi-turn chats the history changes the meaning. */
  function semanticText(req: ChatRequest): string | null {
    const users = req.messages.filter((m) => m.role === 'user');
    const assistants = req.messages.filter((m) => m.role === 'assistant');
    return users.length === 1 && assistants.length === 0 ? users[0].content.trim() : null;
  }

  async function callWithTimeout(p: Provider, req: ChatRequest, parent?: AbortSignal): Promise<Completion> {
    const signal = AbortSignal.any([AbortSignal.timeout(o.timeoutMs ?? 60_000), ...(parent ? [parent] : [])]);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProviderError(`${p.name}: ${parent?.aborted ? 'cancelled' : 'timeout'}`, { retryable: !parent?.aborted }));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const call = p.complete(req, signal);
      call.catch(() => {}); // the race loser may reject later
      return await Promise.race([call, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function chat(req: ChatRequest, ctx: CallContext) {
    const started = now();
    const base = { tenantId: ctx.tenantId, userId: ctx.userId, feature: ctx.feature };
    const record = (u: Omit<UsageRecord, 'tenantId' | 'userId' | 'feature' | 'latencyMs'>) => {
      try {
        const r = o.onUsage?.({ ...base, ...u, latencyMs: now() - started });
        if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((e) => o.onUsageError?.(e));
      } catch (e) {
        o.onUsageError?.(e);
      }
    };

    // 1. Caches first: a hit costs nothing, so it's served even to a tenant that's out of budget.
    const mode = o.cache ? cacheMode(req) : 'bypass';
    const scope = scopeOf(ctx, req);
    const exactKey = sha256(JSON.stringify([scope, req.messages, req.maxTokens ?? null]));
    let embedding: number[] | null = null;
    let semanticQuestion: string | null = null;
    if (mode === 'eligible' && o.cache) {
      const hit = await o.cache.getExact(exactKey);
      if (hit) {
        record({ provider: hit.provider, model: hit.model, cache: 'exact', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom: [], ok: true });
        return { ...hit, cache: 'exact' as const, costUsd: 0, fallbackFrom: [] as string[] };
      }
      if (semanticText(req) && o.embed && semanticMode !== 'off') {
        semanticQuestion = semanticText(req);
        embedding = await o.embed(semanticQuestion!);
        const similar = await o.cache.findSimilar(scope, embedding, threshold);
        if (similar && semanticMode === 'serve') {
          record({ provider: similar.value.provider, model: similar.value.model, cache: 'semantic', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom: [], ok: true });
          return { ...similar.value, cache: 'semantic' as const, similarity: similar.similarity, costUsd: 0, fallbackFrom: [] as string[] };
        }
        if (similar) {
          // Shadow: would have served this — log the pair for labelling, then call the model anyway.
          o.onShadowHit?.({ tenantId: ctx.tenantId, question: semanticQuestion!, cachedQuestion: similar.value.question, similarity: similar.similarity });
        }
      }
    }

    // 2. Budget: atomically reserve a pessimistic estimate before spending; settle with the real cost.
    let reserved = 0;
    if (o.budget) {
      const limit = await o.budget.monthlyLimitUsd(ctx.tenantId);
      const estimate = o.budget.estimateUsd?.(req) ?? defaultEstimateUsd(o.prices, o.providers.map((p) => p.model), req);
      if (!(await o.budget.store.reserve(ctx.tenantId, period(), estimate, limit))) {
        record({ provider: null, model: null, cache: 'bypass', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom: [], ok: false, error: 'budget exceeded' });
        throw new BudgetExceededError(`monthly LLM budget of $${limit} reached for tenant ${ctx.tenantId}`);
      }
      reserved = estimate;
    }
    let settled = false;
    const settle = async (actual: number) => {
      if (!o.budget || settled) return;
      settled = true;
      await o.budget.store.settle(ctx.tenantId, period(), reserved, actual);
    };

    try {
      return await callProviders(req, ctx, mode, scope, exactKey, embedding, semanticQuestion, record, settle);
    } finally {
      await settle(0); // no-op if the success path already settled; releases the reservation on failure
    }
  }

  async function callProviders(
    req: ChatRequest,
    ctx: CallContext,
    mode: 'eligible' | 'bypass',
    scope: string,
    exactKey: string,
    embedding: number[] | null,
    semanticQuestion: string | null,
    record: (u: Omit<UsageRecord, 'tenantId' | 'userId' | 'feature' | 'latencyMs'>) => void,
    settle: (actual: number) => Promise<void>,
  ) {
    // 3. Provider chain.
    const errors: unknown[] = [];
    const fallbackFrom: string[] = [];
    for (const p of o.providers) {
      const b = breakers.get(p.name) ?? { failures: 0, openUntil: 0 };
      breakers.set(p.name, b);
      if (now() < b.openUntil) {
        fallbackFrom.push(p.name);
        errors.push(new ProviderError(`${p.name}: circuit open`));
        continue;
      }
      try {
        const out = await callWithTimeout(p, req, ctx.signal);
        b.failures = 0;
        const cost = costUsd(o.prices, p.model, out.usage);
        await settle(cost);
        const value: CachedResponse = { content: out.content, model: p.model, provider: p.name };
        if (mode === 'eligible' && o.cache) {
          await o.cache.setExact(exactKey, value, ttl);
          if (embedding) await o.cache.saveSimilar(scope, embedding, { ...value, question: semanticQuestion ?? undefined }, ttl);
        }
        record({ provider: p.name, model: p.model, cache: mode === 'eligible' ? 'miss' : 'bypass', ...out.usage, costUsd: cost, fallbackFrom, ok: true });
        return { ...value, cache: mode === 'eligible' ? ('miss' as const) : ('bypass' as const), usage: out.usage, costUsd: cost, fallbackFrom };
      } catch (err) {
        errors.push(err);
        const retryable = err instanceof ProviderError ? err.retryable : true;
        if (!retryable) {
          record({ provider: p.name, model: p.model, cache: 'bypass', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom, ok: false, error: String(err) });
          throw err; // a malformed request fails the same way everywhere — don't burn the fallback
        }
        if (ctx.signal?.aborted) throw err;
        if (++b.failures >= breakerCfg.threshold) b.openUntil = now() + breakerCfg.cooldownMs;
        fallbackFrom.push(p.name);
      }
    }
    record({ provider: null, model: null, cache: 'bypass', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom, ok: false, error: 'all providers failed' });
    throw new AllProvidersFailedError(errors);
  }

  return { chat };
}

// ---------- In-memory stores (dev/tests; use Redis/Postgres in production) ----------

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function memoryCache(now: () => number = Date.now): CacheStore {
  const exact = new Map<string, { value: CachedResponse; exp: number }>();
  const semantic: Array<{ scope: string; embedding: number[]; value: CachedResponse; exp: number }> = [];
  return {
    async getExact(k) {
      const e = exact.get(k);
      return e && e.exp > now() ? e.value : null;
    },
    async setExact(k, value, ttlSec) {
      exact.set(k, { value, exp: now() + ttlSec * 1000 });
    },
    async findSimilar(scope, embedding, min) {
      let best: { value: CachedResponse; similarity: number } | null = null;
      for (const e of semantic) {
        if (e.scope !== scope || e.exp <= now()) continue;
        const s = cosineSimilarity(embedding, e.embedding);
        if (s >= min && (!best || s > best.similarity)) best = { value: e.value, similarity: s };
      }
      return best;
    },
    async saveSimilar(scope, embedding, value, ttlSec) {
      semantic.push({ scope, embedding, value, exp: now() + ttlSec * 1000 });
    },
  };
}

/** Single-process only (the check-and-reserve is atomic because JS is single-threaded). */
export function memoryBudget() {
  const m = new Map<string, { spent: number; reserved: number }>();
  const get = (k: string) => m.get(k) ?? m.set(k, { spent: 0, reserved: 0 }).get(k)!;
  const store: BudgetStore & { snapshot(t: string, p: string): { spent: number; reserved: number } } = {
    async reserve(t, p, usd, limit) {
      const b = get(`${t}:${p}`);
      if (b.spent + b.reserved + usd > limit) return false;
      b.reserved += usd;
      return true;
    },
    async settle(t, p, reserved, actual) {
      const b = get(`${t}:${p}`);
      b.reserved = Math.max(0, b.reserved - reserved);
      b.spent += actual;
    },
    snapshot: (t, p) => ({ ...get(`${t}:${p}`) }),
  };
  return store;
}
