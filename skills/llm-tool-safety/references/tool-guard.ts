// Guardrails for the tools an LLM agent can call. The model proposes calls; this layer decides what runs:
//  - every tool has a tier: read, write or destructive;
//  - arguments are checked against the tool's schema before anything runs, and the tenant comes from the
//    session, never from the model;
//  - once untrusted content (a retrieved document, an email, a web page) is in the model's context, write
//    tools need a human approval. Destructive tools always do. The taint is stored with the session, so the
//    agent's next turn (another request, maybe another instance) still knows;
//  - an approval covers one exact call (tool + arguments), is used once, and expires;
//  - write results are kept by tool-call id, so an agent that retries a call gets the first result instead of
//    running it twice;
//  - every call is audited.
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

export type Tier = 'read' | 'write' | 'destructive';

export type ParamSpec = { required?: boolean; description?: string } & (
  | { type: 'string'; maxLength?: number; pattern?: RegExp }
  | { type: 'integer' | 'number'; min?: number; max?: number }
  | { type: 'boolean' }
  | { type: 'enum'; values: string[] }
);

export interface ToolContext {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  tier: Tier;
  params: Record<string, ParamSpec>;
  /** The output comes from outside the user (documents, mail, the web): reading it taints the session. */
  returnsUntrusted?: boolean;
  /** Who may approve: the requesting user (a confirmation) or someone else (four eyes). Default 'requester'. */
  approvedBy?: 'requester' | 'someone-else';
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export type CallResult =
  | { status: 'ok'; result: unknown; replayed?: boolean }
  | { status: 'approval_required'; approvalId: string; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'error'; message: string };

export class ToolArgumentError extends Error {}

/** Strict validation: unknown, missing or ill-typed arguments are refused before the tool runs. */
export function validateArgs(tool: ToolDef, raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolArgumentError('arguments must be an object');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(tool.params, key)) throw new ToolArgumentError(`unknown argument "${key}"`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(tool.params)) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (spec.required) throw new ToolArgumentError(`missing argument "${key}"`);
      continue;
    }
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') throw new ToolArgumentError(`"${key}" must be a string`);
        if (spec.maxLength !== undefined && v.length > spec.maxLength) throw new ToolArgumentError(`"${key}" is longer than ${spec.maxLength}`);
        if (spec.pattern && !spec.pattern.test(v)) throw new ToolArgumentError(`"${key}" has the wrong format`);
        break;
      case 'integer':
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v) || (spec.type === 'integer' && !Number.isInteger(v))) {
          throw new ToolArgumentError(`"${key}" must be ${spec.type === 'integer' ? 'an integer' : 'a number'}`);
        }
        if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
          throw new ToolArgumentError(`"${key}" is out of range`);
        }
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw new ToolArgumentError(`"${key}" must be true or false`);
        break;
      case 'enum':
        if (typeof v !== 'string' || !spec.values.includes(v)) throw new ToolArgumentError(`"${key}" must be one of ${spec.values.join(', ')}`);
        break;
    }
    out[key] = v;
  }
  return out;
}

const hashArgs = (tool: string, args: Record<string, unknown>) =>
  createHash('sha256').update(`${tool}\n${JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]))}`).digest('hex');

// ---------- Ports ----------

/**
 * Which agent sessions have untrusted content in their context. Sticky: a session never becomes trusted again.
 * It must outlive the request, because the agent's next turn is another request, maybe on another instance, and
 * the content it read is still in its context.
 */
export interface TaintStore {
  isUntrusted(ctx: ToolContext): Promise<boolean>;
  markUntrusted(ctx: ToolContext): Promise<void>;
}

/** TaintStore on the tool_sessions table (tool-guard.sql). */
export function pgTaintStore(pool: pg.Pool): TaintStore {
  return {
    async isUntrusted(ctx) {
      const res = await pool.query(`SELECT 1 FROM tool_sessions WHERE tenant_id = $1 AND session_id = $2`, [ctx.tenantId, ctx.sessionId]);
      return res.rowCount === 1;
    },
    async markUntrusted(ctx) {
      await pool.query(`INSERT INTO tool_sessions (tenant_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ctx.tenantId, ctx.sessionId]);
    },
  };
}

// ---------- Persistence: approvals, results by tool-call id, audit ----------

type Outcome = 'ok' | 'error' | 'approval_required' | 'rejected' | 'replayed';

interface AuditEvent {
  tool: string;
  tier?: Tier;
  argsHash?: string;
  outcome: Outcome;
  toolCallId?: string;
  approvalId?: string;
  detail?: string;
}

interface PriorResult {
  argsHash: string;
  status: 'running' | 'done';
  result: unknown;
  /** Still 'running' long after its claim: the process that claimed it died. */
  stale: boolean;
}

class ToolCallLog {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async audit(s: ToolContext, untrusted: boolean, e: AuditEvent): Promise<void> {
    await this.#pool.query(
      `INSERT INTO tool_audit (tenant_id, user_id, session_id, tool_call_id, tool, tier, args_hash, outcome, approval_id, untrusted_context, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [s.tenantId, s.userId, s.sessionId, e.toolCallId ?? null, e.tool, e.tier ?? null, e.argsHash ?? null, e.outcome, e.approvalId ?? null, untrusted, e.detail?.slice(0, 2000) ?? null],
    );
  }

  async requestApproval(s: ToolContext, tool: string, args: Record<string, unknown>, argsHash: string, reason: string, ttlSec: number): Promise<string> {
    const { rows } = await this.#pool.query(
      `INSERT INTO tool_approvals (tenant_id, requested_by, session_id, tool, args, args_hash, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8)) RETURNING id`,
      [s.tenantId, s.userId, s.sessionId, tool, JSON.stringify(args), argsHash, reason, ttlSec],
    );
    return rows[0].id;
  }

  /** Spend an approval atomically, only if it was granted for exactly this call and isn't used or expired. null = spent, else why not. */
  async spendApproval(s: ToolContext, approvalId: string, tool: string, argsHash: string): Promise<string | null> {
    const used = await this.#pool.query(
      `UPDATE tool_approvals SET status = 'used', used_at = now()
        WHERE id = $1 AND status = 'approved' AND expires_at > now()
          AND tenant_id = $2 AND session_id = $3 AND tool = $4 AND args_hash = $5`,
      [approvalId, s.tenantId, s.sessionId, tool, argsHash],
    );
    if (used.rowCount === 1) return null;
    const { rows } = await this.#pool.query(
      `SELECT status, expires_at <= now() AS expired, tool = $2 AND args_hash = $3 AS same_call, tenant_id = $4 AND session_id = $5 AS same_session
         FROM tool_approvals WHERE id = $1`,
      [approvalId, tool, argsHash, s.tenantId, s.sessionId],
    );
    const r = rows[0];
    if (!r || !r.same_session) return 'no such approval for this session';
    if (!r.same_call) return 'the approval was given for a different call (tool or arguments changed)';
    if (r.status === 'used') return 'the approval was already used';
    if (r.status !== 'approved') return `the approval is ${r.status}`;
    return 'the approval has expired';
  }

  async decide(approvalId: string, approver: { tenantId: string; userId: string }, decision: 'approved' | 'denied', mayDecide: (tool: string, requestedBy: string) => boolean): Promise<boolean> {
    const { rows } = await this.#pool.query(`SELECT tool, requested_by FROM tool_approvals WHERE id = $1 AND tenant_id = $2`, [approvalId, approver.tenantId]);
    if (!rows[0] || !mayDecide(rows[0].tool, rows[0].requested_by)) return false;
    const res = await this.#pool.query(
      `UPDATE tool_approvals SET status = $3, decided_by = $2, decided_at = now()
        WHERE id = $1 AND tenant_id = $4 AND status = 'pending' AND expires_at > now()`,
      [approvalId, approver.userId, decision, approver.tenantId],
    );
    return res.rowCount === 1;
  }

  async prior(s: ToolContext, toolCallId: string, staleSec: number): Promise<PriorResult | null> {
    const { rows } = await this.#pool.query(
      `SELECT args_hash, status, result, status = 'running' AND created_at < now() - make_interval(secs => $3) AS stale
         FROM tool_results WHERE tenant_id = $1 AND tool_call_id = $2`,
      [s.tenantId, toolCallId, staleSec],
    );
    return rows[0] ? { argsHash: rows[0].args_hash, status: rows[0].status, result: rows[0].result, stale: rows[0].stale } : null;
  }

  /** Claim a tool-call id, or take over a claim whose process died. Returns the claim token, or null if it's taken. */
  async claim(s: ToolContext, toolCallId: string, tool: string, argsHash: string, staleSec: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.#pool.query(
      `INSERT INTO tool_results AS r (tenant_id, tool_call_id, tool, args_hash, status, claim_token) VALUES ($1, $2, $3, $4, 'running', $5)
       ON CONFLICT (tenant_id, tool_call_id) DO UPDATE SET claim_token = EXCLUDED.claim_token, created_at = now()
         WHERE r.status = 'running' AND r.args_hash = EXCLUDED.args_hash AND r.created_at < now() - make_interval(secs => $6)`,
      [s.tenantId, toolCallId, tool, argsHash, token, staleSec],
    );
    return res.rowCount === 1 ? token : null;
  }

  async finish(s: ToolContext, toolCallId: string, token: string, result: unknown): Promise<void> {
    await this.#pool.query(`UPDATE tool_results SET status = 'done', result = $4 WHERE tenant_id = $1 AND tool_call_id = $2 AND claim_token = $3`, [
      s.tenantId,
      toolCallId,
      token,
      JSON.stringify(result ?? null),
    ]);
  }

  /** The run failed: free the id for a retry, unless the claim was taken over meanwhile. */
  async release(s: ToolContext, toolCallId: string, token: string): Promise<void> {
    await this.#pool.query(`DELETE FROM tool_results WHERE tenant_id = $1 AND tool_call_id = $2 AND status = 'running' AND claim_token = $3`, [s.tenantId, toolCallId, token]);
  }
}

// ---------- Guard and sessions ----------

export interface ToolGuardOptions {
  pool: pg.Pool;
  tools: ToolDef[];
  /** How long an approval request stays valid. Default 900 s. */
  approvalTtlSec?: number;
  /** A tool call still 'running' this long after its claim belongs to a process that died; a retry takes it over. Default 600 s. */
  staleRunSec?: number;
  /** Where session taint is kept. Default: Postgres (tool_sessions). */
  taint?: TaintStore;
}

/** What every session of one guard shares. */
interface GuardDeps {
  tools: Map<string, ToolDef>;
  log: ToolCallLog;
  taint: TaintStore;
  approvalTtlSec: number;
  staleRunSec: number;
}

/** One agent conversation. Cheap to create: make one per request from the authenticated session's ids. */
export class ToolSession {
  readonly #ctx: ToolContext;
  readonly #deps: GuardDeps;
  #untrusted = false;

  constructor(ctx: ToolContext, deps: GuardDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /** True once this object has seen or loaded the taint. For the authoritative answer, await isUntrusted(). */
  get untrusted(): boolean {
    return this.#untrusted;
  }

  /** Whether untrusted content is in this conversation's context, as stored (possibly by another instance). */
  async isUntrusted(): Promise<boolean> {
    if (!this.#untrusted) this.#untrusted = await this.#deps.taint.isUntrusted(this.#ctx);
    return this.#untrusted;
  }

  /** For content the app itself puts into the context: a pasted email, retrieved chunks, a fetched page. */
  async markUntrusted(): Promise<void> {
    this.#untrusted = true;
    await this.#deps.taint.markUntrusted(this.#ctx);
  }

  async call(name: string, rawArgs: unknown, opts: { toolCallId?: string; approvalId?: string } = {}): Promise<CallResult> {
    const { tools, log } = this.#deps;
    const untrusted = await this.isUntrusted(); // the context as the model saw it when it proposed this call
    const audit = (e: AuditEvent) => log.audit(this.#ctx, untrusted, e);
    const tool = tools.get(name);
    if (!tool) {
      await audit({ tool: name, outcome: 'rejected', toolCallId: opts.toolCallId, detail: 'unknown tool' });
      return { status: 'rejected', reason: `unknown tool "${name}"` };
    }
    let args: Record<string, unknown>;
    try {
      args = validateArgs(tool, rawArgs);
    } catch (err) {
      await audit({ tool: name, tier: tool.tier, outcome: 'rejected', toolCallId: opts.toolCallId, detail: (err as Error).message });
      return { status: 'rejected', reason: (err as Error).message };
    }
    const argsHash = hashArgs(name, args);
    const base = { tool: name, tier: tool.tier, argsHash, toolCallId: opts.toolCallId, approvalId: opts.approvalId };
    const reject = async (reason: string): Promise<CallResult> => {
      await audit({ ...base, outcome: 'rejected', detail: reason });
      return { status: 'rejected', reason };
    };
    const callId = tool.tier === 'read' ? undefined : opts.toolCallId;

    // 1. A retry of a call that already ran gets its first result. Nothing runs again, so no approval is spent.
    if (callId) {
      const prior = await log.prior(this.#ctx, callId, this.#deps.staleRunSec);
      if (prior && prior.argsHash !== argsHash) return reject('tool call id reused with different arguments');
      if (prior?.status === 'done') {
        await audit({ ...base, outcome: 'replayed' });
        return { status: 'ok', result: prior.result, replayed: true };
      }
      if (prior && !prior.stale) return reject('this call is still running');
    }

    // 2. Approval: always for destructive tools, and for writes once untrusted content is in the context.
    const reason = tool.tier === 'destructive' ? 'destructive tool' : tool.tier === 'write' && untrusted ? 'write tool after untrusted content entered the context' : null;
    if (reason) {
      if (!opts.approvalId) {
        const approvalId = await log.requestApproval(this.#ctx, name, args, argsHash, reason, this.#deps.approvalTtlSec);
        await audit({ ...base, outcome: 'approval_required', approvalId, detail: reason });
        return { status: 'approval_required', approvalId, reason };
      }
      const refused = await log.spendApproval(this.#ctx, opts.approvalId, name, argsHash);
      if (refused) return reject(refused);
    }

    // 3. Writes run once per tool-call id: claim it, or take over the claim of a process that died.
    const token = callId ? await log.claim(this.#ctx, callId, name, argsHash, this.#deps.staleRunSec) : null;
    if (callId && !token) return reject('this call is still running');
    try {
      const result = await tool.run(args, this.#ctx);
      if (tool.returnsUntrusted) await this.markUntrusted(); // the model has now read text nobody vetted
      if (token) await log.finish(this.#ctx, callId!, token, result);
      await audit({ ...base, outcome: 'ok' });
      return { status: 'ok', result };
    } catch (err) {
      if (token) await log.release(this.#ctx, callId!, token);
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      await audit({ ...base, outcome: 'error', detail: message });
      return { status: 'error', message };
    }
  }
}

export class ToolGuard {
  readonly #deps: GuardDeps;

  constructor(o: ToolGuardOptions) {
    const tools = new Map(o.tools.map((t) => [t.name, t]));
    if (tools.size !== o.tools.length) throw new Error('tool guard: tool names must be unique');
    for (const t of o.tools) {
      if (!['read', 'write', 'destructive'].includes(t.tier)) throw new Error(`tool guard: ${t.name}: unknown tier "${t.tier}"`);
      for (const [key, spec] of Object.entries(t.params)) {
        // test() on a g or y regex continues from lastIndex: every other call would validate a different way.
        if (spec.type === 'string' && spec.pattern && (spec.pattern.global || spec.pattern.sticky)) {
          throw new Error(`tool guard: ${t.name}.${key}: pattern must not have the g or y flag`);
        }
      }
    }
    const approvalTtlSec = o.approvalTtlSec ?? 900;
    const staleRunSec = o.staleRunSec ?? 600;
    if (!(approvalTtlSec > 0) || !(staleRunSec > 0)) throw new RangeError('tool guard: approvalTtlSec and staleRunSec must be positive');
    this.#deps = { tools, log: new ToolCallLog(o.pool), taint: o.taint ?? pgTaintStore(o.pool), approvalTtlSec, staleRunSec };
  }

  session(ctx: ToolContext): ToolSession {
    return new ToolSession(ctx, this.#deps);
  }

  /**
   * Record a human decision. `approver` comes from the approver's authenticated session: an approval is only
   * visible to its own tenant. Returns false if the approval is gone, already decided, of another tenant, or this
   * approver may not decide it (four eyes).
   */
  decide(approvalId: string, approver: { tenantId: string; userId: string }, decision: 'approved' | 'denied'): Promise<boolean> {
    if (approver === null || typeof approver !== 'object') throw new TypeError('decide(): pass the approver as { tenantId, userId }');
    return this.#deps.log.decide(approvalId, approver, decision, (tool, requestedBy) => !(this.#deps.tools.get(tool)?.approvedBy === 'someone-else' && requestedBy === approver.userId));
  }

  /** JSON Schema for each tool, to hand to the model. The tier is part of the description. */
  schemas() {
    return [...this.#deps.tools.values()].map((t) => ({
      name: t.name,
      description: `${t.description}${t.tier === 'destructive' ? ' (needs a human approval)' : t.tier === 'write' ? ' (may need a human approval)' : ''}`,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: Object.entries(t.params).filter(([, p]) => p.required).map(([k]) => k),
        properties: Object.fromEntries(
          Object.entries(t.params).map(([k, p]) => {
            const common = p.description ? { description: p.description } : {};
            switch (p.type) {
              case 'string':
                return [k, { type: 'string', ...common, ...(p.maxLength ? { maxLength: p.maxLength } : {}), ...(p.pattern ? { pattern: p.pattern.source } : {}) }];
              case 'integer':
              case 'number':
                return [k, { type: p.type, ...common, ...(p.min !== undefined ? { minimum: p.min } : {}), ...(p.max !== undefined ? { maximum: p.max } : {}) }];
              case 'boolean':
                return [k, { type: 'boolean', ...common }];
              case 'enum':
                return [k, { type: 'string', enum: p.values, ...common }];
            }
          }),
        ),
      },
    }));
  }
}

export const createToolGuard = (o: ToolGuardOptions) => new ToolGuard(o);
