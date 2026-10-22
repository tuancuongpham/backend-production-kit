// Provider-agnostic LLM gateway core: exact cache → semantic cache → budget reservation → provider chain with
// timeout + circuit breaker + fallback → cost accounting.
// Plug real providers in via the `Provider` interface (Anthropic/OpenAI SDKs, AI SDK,
// or an upstream gateway such as LiteLLM / Vercel AI Gateway).
import { createHash } from 'node:crypto';
import { CircuitBreaker } from './circuit-breaker.ts';
import { callHook } from './hooks.ts';

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

/** Where optional infrastructure failed. None of these fails a request. */
export type GatewayStage = 'cache-read' | 'cache-write' | 'embed' | 'budget-settle' | 'usage';

export interface GatewayOptions {
  /** Primary first, then fallbacks (typically a cheaper/other-vendor model). Names must be unique. */
  providers: Provider[];
  prices: PriceTable;
  cache?: CacheStore;
  /** Needed for the semantic cache. Embedding calls cost money too — count them in your FinOps. */
  embed?: (text: string) => Promise<number[]>;
  /**
   * 'shadow' (default): look up similar entries and report them via onShadowHit, but still call the
   * model — collects labelled pairs to tune the threshold. The lookup runs beside the model call, so it adds
   * no latency. 'serve' only after that eval passes.
   */
  semanticMode?: 'off' | 'shadow' | 'serve';
  semanticThreshold?: number; // cosine similarity, default 0.95
  onShadowHit?: (h: ShadowHit) => unknown;
  cacheTtlSec?: number; // default 24h
  /**
   * TTL for answers that came from a fallback provider (default 300 s). They are what was available during an
   * outage; with the full TTL they would keep being served for a day after the primary recovers. 0 = don't cache.
   */
  fallbackCacheTtlSec?: number;
  budget?: {
    store: BudgetStore;
    monthlyLimitUsd: (tenantId: string) => number | Promise<number>;
    /** Upper-bound cost of a request, reserved before the call. Default: chars/4 input + maxTokens output at the priciest model in the chain. */
    estimateUsd?: (req: ChatRequest) => number;
  };
  /** Accounting must never fail the user's request: errors (sync or async) are swallowed and passed to onUsageError. */
  onUsage?: (u: UsageRecord) => unknown;
  onUsageError?: (err: unknown) => unknown;
  /**
   * Failures of optional infrastructure: the cache store, embeddings, settling the budget after a call (the
   * reservation then stays until you reconcile it from llm_usage), and the usage sink when onUsageError isn't set.
   * Log and count them: the request goes on without that piece.
   */
  onError?: (err: unknown, stage: GatewayStage) => unknown;
  timeoutMs?: number; // per provider attempt, default 60s
  /** Per provider: open after `threshold` failures in a row; after `cooldownMs`, one probe call decides. Default 3 → 30 s. */
  breaker?: { threshold: number; cooldownMs: number };
  now?: () => number;
}

export interface CallContext {
  tenantId: string;
  userId?: string;
  feature?: string;
  signal?: AbortSignal;
}

export interface ChatResult extends CachedResponse {
  cache: 'exact' | 'semantic' | 'miss' | 'bypass';
  costUsd: number;
  /** Providers skipped or failed before the one that answered. */
  fallbackFrom: string[];
  /** Tokens of the model call; absent on cache hits. */
  usage?: Usage;
  /** Semantic cache hits only. */
  similarity?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function costUsd(prices: PriceTable, model: string, u: Usage): number {
  const p = prices[model];
  if (!p) return 0; // surface missing prices via a metric/alert rather than failing the request
  return (u.inputTokens * p.inputPer1M + u.outputTokens * p.outputPer1M) / 1_000_000;
}

/**
 * Token counts that can be priced, or null. Some SDKs return a streamed or cached answer without usage, or with a
 * count missing: priced as is, that is NaN dollars, and NaN in a budget row never compares true again.
 */
function countedUsage(u: Partial<Usage> | undefined): Usage | null {
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return u && ok(u.inputTokens) && ok(u.outputTokens) ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : null;
}

/** A cached answer as the caller gets it: without the question that produced it, which another user may have asked. */
const answerOf = (v: CachedResponse): CachedResponse => ({ content: v.content, model: v.model, provider: v.provider });

/** Deliberately pessimistic: a reservation that's too small lets concurrent requests overshoot. */
export function defaultEstimateUsd(prices: PriceTable, models: string[], req: ChatRequest): number {
  const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
  const inputTokens = Math.ceil(chars / 4) + 50;
  const outputTokens = req.maxTokens ?? 1024;
  return Math.max(0, ...models.map((m) => costUsd(prices, m, { inputTokens, outputTokens })));
}

type Accounting = Omit<UsageRecord, 'tenantId' | 'userId' | 'feature' | 'latencyMs'>;

interface SemanticLookup {
  question: string;
  embedding: number[] | null;
  similar: { value: CachedResponse; similarity: number } | null;
}

/** A budget reservation for one call: settled once with the real cost, or released (settled at 0). */
interface Reservation {
  /** What was reserved: booked as the cost when the provider's answer comes without usable token counts. */
  estimateUsd: number;
  settle(actualUsd: number): Promise<void>;
}

/** A dollar amount from the app (a plan's limit, an estimate): a finite number of 0 or more, else the call is refused. */
function dollars(what: string, usd: unknown): number {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    throw new Error(`llm-gateway: ${what} is ${String(usd)}, not an amount of dollars: the budget can't be enforced, so the call is refused`);
  }
  return usd;
}

export class LlmGateway {
  readonly #providers: Provider[];
  readonly #prices: PriceTable;
  readonly #cache?: CacheStore;
  readonly #embed?: (text: string) => Promise<number[]>;
  readonly #semanticMode: 'off' | 'shadow' | 'serve';
  readonly #threshold: number;
  readonly #ttlSec: number;
  readonly #fallbackTtlSec: number;
  readonly #budget?: GatewayOptions['budget'];
  readonly #onShadowHit?: (h: ShadowHit) => unknown;
  readonly #onUsage?: GatewayOptions['onUsage'];
  readonly #onUsageError?: (err: unknown) => unknown;
  readonly #onError?: GatewayOptions['onError'];
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #breakers: Map<string, CircuitBreaker>;

  constructor(o: GatewayOptions) {
    if (o.providers.length === 0) throw new Error('llm-gateway: at least one provider is required');
    const names = o.providers.map((p) => p.name);
    if (new Set(names).size !== names.length) throw new Error(`llm-gateway: provider names must be unique (each has its own circuit breaker): ${names.join(', ')}`);
    // A model without a price costs "$0": its estimate reserves nothing and its spend never counts,
    // so the budget silently stops limiting. Refuse that configuration up front.
    if (o.budget) {
      const unpriced = o.providers.map((p) => p.model).filter((m) => !o.prices[m]);
      if (unpriced.length) throw new Error(`llm-gateway: no price configured for model(s) ${unpriced.join(', ')}; budgets cannot be enforced`);
    }
    // A number read from an unset environment variable is NaN. A NaN timeout fails every provider (and opens their
    // breakers), a NaN TTL caches nothing, and a threshold of NaN, or 95 meant as 95%, never matches.
    const setting = (name: string, v: number, ok: boolean, rule: string) => {
      if (!ok) throw new RangeError(`llm-gateway: ${name} must be ${rule}, got ${v}`);
      return v;
    };
    const timeoutMs = o.timeoutMs ?? 60_000;
    const threshold = o.semanticThreshold ?? 0.95;
    const ttlSec = o.cacheTtlSec ?? 86_400;
    const fallbackTtlSec = o.fallbackCacheTtlSec ?? 300;
    this.#timeoutMs = setting('timeoutMs', timeoutMs, Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 2 ** 31 - 1, 'a whole number of ms');
    this.#threshold = setting('semanticThreshold', threshold, threshold > 0 && threshold <= 1, 'a cosine similarity above 0 and at most 1 (0.95, not 95)');
    this.#ttlSec = setting('cacheTtlSec', ttlSec, Number.isFinite(ttlSec) && ttlSec >= 0, 'a number of seconds, 0 or more');
    this.#fallbackTtlSec = setting('fallbackCacheTtlSec', fallbackTtlSec, Number.isFinite(fallbackTtlSec) && fallbackTtlSec >= 0, 'a number of seconds, 0 or more');
    this.#providers = o.providers;
    this.#prices = o.prices;
    this.#cache = o.cache;
    this.#embed = o.embed;
    this.#semanticMode = o.semanticMode ?? 'shadow';
    this.#budget = o.budget;
    this.#onShadowHit = o.onShadowHit;
    this.#onUsage = o.onUsage;
    this.#onUsageError = o.onUsageError;
    this.#onError = o.onError;
    this.#now = o.now ?? Date.now;
    const breaker = o.breaker ?? { threshold: 3, cooldownMs: 30_000 };
    this.#breakers = new Map(o.providers.map((p) => [p.name, new CircuitBreaker({ ...breaker, now: this.#now })]));
  }

  async chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    ctx.signal?.throwIfAborted(); // nobody is waiting for this answer: don't pay for it
    const started = this.#now();
    const record = (u: Accounting) => this.#record(ctx, started, u);

    // 1. Caches first: a hit costs nothing, so it's served even to a tenant that's out of budget.
    const cacheable = this.#cache !== undefined && this.#cacheable(req);
    const scope = this.#scopeOf(ctx, req);
    const exactKey = sha256(JSON.stringify([scope, req.messages, req.maxTokens ?? null]));
    let semantic: Promise<SemanticLookup> | null = null;
    if (cacheable) {
      const hit = await this.#bestEffort('cache-read', () => this.#cache!.getExact(exactKey), null);
      if (hit) {
        record({ provider: hit.provider, model: hit.model, cache: 'exact', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom: [], ok: true });
        return { ...answerOf(hit), cache: 'exact', costUsd: 0, fallbackFrom: [] };
      }
      const question = this.#semanticText(req);
      if (question !== null && this.#embed && this.#semanticMode !== 'off') {
        semantic = this.#semanticLookup(ctx, scope, question);
        if (this.#semanticMode === 'serve') {
          const { similar } = await semantic;
          if (similar) {
            record({ provider: similar.value.provider, model: similar.value.model, cache: 'semantic', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom: [], ok: true });
            // The entry keeps the question it was cached for (to label shadow hits). That question may be another
            // user's, with their name and order in it: the caller gets the answer only.
            return { ...answerOf(similar.value), cache: 'semantic', similarity: similar.similarity, costUsd: 0, fallbackFrom: [] };
          }
        }
        // Shadow mode: the lookup keeps running beside the model call and reports what it would have served.
      }
    }

    // 2. Budget: atomically reserve a pessimistic estimate before spending; settle with the real cost.
    const reservation = await this.#reserve(req, ctx, record);
    try {
      // 3. Provider chain.
      const { provider, completion, fallbackFrom } = await this.#callChain(req, ctx, record);
      // The answer exists and is paid for. Nothing below may fail the request or buy it again elsewhere.
      const usage = countedUsage(completion.usage);
      let cost = usage ? costUsd(this.#prices, provider.model, usage) : Number.NaN;
      if (!Number.isFinite(cost)) {
        // Unknown cost: book the pessimistic estimate, so the budget stays a number and errs on the safe side.
        cost = reservation?.estimateUsd ?? defaultEstimateUsd(this.#prices, [provider.model], req);
        this.#report(new Error(`llm-gateway: ${provider.name} answered without usable token counts; booked the estimate of $${cost}`), 'usage');
      }
      await reservation?.settle(cost);
      const value: CachedResponse = { content: completion.content, model: provider.model, provider: provider.name };
      if (cacheable) await this.#remember(scope, exactKey, value, semantic, fallbackFrom.length > 0);
      const cache = cacheable ? 'miss' : 'bypass';
      record({ provider: provider.name, model: provider.model, cache, ...(usage ?? { inputTokens: 0, outputTokens: 0 }), costUsd: cost, fallbackFrom, ok: true });
      return { ...value, cache, ...(usage ? { usage } : {}), costUsd: cost, fallbackFrom };
    } finally {
      await reservation?.settle(0); // no-op after a successful settle; releases the reservation on failure
    }
  }

  /** Only deterministic, tool-free requests are safe to serve from cache. */
  #cacheable(req: ChatRequest): boolean {
    return req.cache !== false && (req.temperature ?? 0) <= 0 && (req.tools?.length ?? 0) === 0;
  }

  /** Scope = tenant + model route + system prompt: a cached answer never crosses those lines. */
  #scopeOf(ctx: CallContext, req: ChatRequest): string {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    return sha256(JSON.stringify([ctx.tenantId, this.#providers.map((p) => p.model), system]));
  }

  /** Semantic matching only for single-question requests; in multi-turn chats the history changes the meaning. */
  #semanticText(req: ChatRequest): string | null {
    const users = req.messages.filter((m) => m.role === 'user');
    const assistants = req.messages.filter((m) => m.role === 'assistant');
    return users.length === 1 && assistants.length === 0 ? users[0].content.trim() : null;
  }

  /** Never rejects: an embedding or cache failure only means no semantic cache for this request. */
  async #semanticLookup(ctx: CallContext, scope: string, question: string): Promise<SemanticLookup> {
    let embedding: number[];
    try {
      embedding = await this.#embed!(question);
    } catch (err) {
      this.#report(err, 'embed');
      return { question, embedding: null, similar: null };
    }
    const similar = await this.#bestEffort('cache-read', () => this.#cache!.findSimilar(scope, embedding, this.#threshold), null);
    if (similar && this.#semanticMode === 'shadow') {
      // Would have served this: report the pair for labelling. The model is called anyway.
      this.#observe('cache-read', () =>
        this.#onShadowHit?.({ tenantId: ctx.tenantId, question, cachedQuestion: similar.value.question, similarity: similar.similarity }),
      );
    }
    return { question, embedding, similar };
  }

  async #reserve(req: ChatRequest, ctx: CallContext, record: (u: Accounting) => void): Promise<Reservation | null> {
    const budget = this.#budget;
    if (!budget) return null;
    // Settle in the period we reserved in, even if the month rolls over while the model generates.
    const period = new Date(this.#now()).toISOString().slice(0, 7); // 'YYYY-MM'
    // A budget is a control, and it fails closed: a store that is down fails the request, and so does a limit or an
    // estimate that isn't a number. A plan missing from the table gives NaN, which compares false in JavaScript and
    // above every amount in Postgres numeric: either way, every reservation would pass.
    let limit: number;
    let estimate: number;
    try {
      limit = dollars(`monthlyLimitUsd(${ctx.tenantId})`, await budget.monthlyLimitUsd(ctx.tenantId));
      estimate = dollars('the cost estimate', budget.estimateUsd?.(req) ?? defaultEstimateUsd(this.#prices, this.#providers.map((p) => p.model), req));
    } catch (err) {
      record({ provider: null, model: null, cache: 'bypass', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom: [], ok: false, error: 'budget misconfigured' });
      throw err;
    }
    if (!(await budget.store.reserve(ctx.tenantId, period, estimate, limit))) {
      record({ provider: null, model: null, cache: 'bypass', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom: [], ok: false, error: 'budget exceeded' });
      throw new BudgetExceededError(`monthly LLM budget of $${limit} reached for tenant ${ctx.tenantId}`);
    }
    let settled = false;
    return {
      estimateUsd: estimate,
      settle: async (actualUsd) => {
        if (settled) return;
        settled = true;
        try {
          await budget.store.settle(ctx.tenantId, period, estimate, actualUsd);
        } catch (err) {
          this.#report(err, 'budget-settle');
        }
      },
    };
  }

  async #callChain(req: ChatRequest, ctx: CallContext, record: (u: Accounting) => void) {
    const errors: unknown[] = [];
    const fallbackFrom: string[] = [];
    for (const provider of this.#providers) {
      ctx.signal?.throwIfAborted();
      const breaker = this.#breakers.get(provider.name)!;
      if (!breaker.tryAcquire()) {
        fallbackFrom.push(provider.name);
        errors.push(new ProviderError(`${provider.name}: circuit open`));
        continue;
      }
      try {
        const completion = await this.#callWithTimeout(provider, req, ctx.signal);
        breaker.success();
        return { provider, completion, fallbackFrom };
      } catch (err) {
        errors.push(err);
        if (ctx.signal?.aborted) throw err; // cancelled by the caller: says nothing about the provider
        const retryable = err instanceof ProviderError ? err.retryable : true;
        if (!retryable) {
          breaker.success(); // it answered; the request was the problem
          record({ provider: provider.name, model: provider.model, cache: 'bypass', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom, ok: false, error: String(err) });
          throw err; // a malformed request fails the same way everywhere — don't burn the fallback
        }
        breaker.failure();
        fallbackFrom.push(provider.name);
      }
    }
    record({ provider: null, model: null, cache: 'bypass', inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackFrom, ok: false, error: 'all providers failed' });
    throw new AllProvidersFailedError(errors);
  }

  async #callWithTimeout(p: Provider, req: ChatRequest, parent?: AbortSignal): Promise<Completion> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), ...(parent ? [parent] : [])]);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProviderError(`${p.name}: ${parent?.aborted ? 'cancelled' : 'timeout'}`, { retryable: !parent?.aborted }));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      const call = p.complete(req, signal);
      call.catch(() => {}); // the race loser may reject later
      return await Promise.race([call, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async #remember(scope: string, exactKey: string, value: CachedResponse, semantic: Promise<SemanticLookup> | null, fromFallback: boolean) {
    const ttl = fromFallback ? this.#fallbackTtlSec : this.#ttlSec;
    if (ttl <= 0) return;
    await this.#bestEffort('cache-write', () => this.#cache!.setExact(exactKey, value, ttl), undefined);
    const lookup = semantic && (await semantic);
    if (lookup?.embedding) {
      const embedding = lookup.embedding;
      await this.#bestEffort('cache-write', () => this.#cache!.saveSimilar(scope, embedding, { ...value, question: lookup.question }, ttl), undefined);
    }
  }

  #record(ctx: CallContext, started: number, u: Accounting) {
    const usage = { tenantId: ctx.tenantId, userId: ctx.userId, feature: ctx.feature, ...u, latencyMs: this.#now() - started };
    if (!this.#onUsageError) return this.#observe('usage', () => this.#onUsage?.(usage));
    try {
      const r = this.#onUsage?.(usage);
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((err) => callHook(this.#onUsageError, err));
    } catch (err) {
      callHook(this.#onUsageError, err);
    }
  }

  /** Runs a hook of the app's; whether it throws or its promise rejects, the failure goes to onError, never further. */
  #observe(stage: GatewayStage, hook: () => unknown) {
    try {
      const r = hook();
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((err) => this.#report(err, stage));
    } catch (err) {
      this.#report(err, stage);
    }
  }

  async #bestEffort<T>(stage: GatewayStage, op: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await op();
    } catch (err) {
      this.#report(err, stage);
      return fallback;
    }
  }

  #report(err: unknown, stage: GatewayStage) {
    callHook(this.#onError, err, stage); // an error hook that throws must not take the request down with it
  }
}

export const createGateway = (o: GatewayOptions) => new LlmGateway(o);

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
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0; // not sqrt(na * nb): the product of two small norms underflows to 0
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
