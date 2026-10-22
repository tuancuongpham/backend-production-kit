// Guardrails for the tools an LLM agent can call. The model proposes calls; this layer decides what runs:
//  - every tool has a tier: read, write or destructive;
//  - arguments are checked against the tool's schema before anything runs, and the tenant comes from the
//    session, never from the model;
//  - once untrusted content (a retrieved document, an email, a web page) is in the model's context, write
//    tools need a human approval. Destructive tools always do;
//  - an approval covers one exact call (tool + arguments), is used once, and expires;
//  - write results are kept by tool-call id, so an agent that retries a call doesn't run it twice;
//  - every call is audited.
import { createHash } from 'node:crypto';
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

export function createToolGuard(o: { pool: pg.Pool; tools: ToolDef[]; approvalTtlSec?: number }) {
  const tools = new Map(o.tools.map((t) => [t.name, t]));
  const approvalTtlSec = o.approvalTtlSec ?? 900;

  async function audit(s: ToolContext & { untrusted: boolean }, e: { tool: string; tier?: Tier; argsHash?: string; outcome: string; toolCallId?: string; approvalId?: string; detail?: string }) {
    await o.pool.query(
      `INSERT INTO tool_audit (tenant_id, user_id, session_id, tool_call_id, tool, tier, args_hash, outcome, approval_id, untrusted_context, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [s.tenantId, s.userId, s.sessionId, e.toolCallId ?? null, e.tool, e.tier ?? null, e.argsHash ?? null, e.outcome, e.approvalId ?? null, s.untrusted, e.detail?.slice(0, 2000) ?? null],
    );
  }

  /** Spend an approval: atomically, only if it was granted for exactly this call and hasn't been used or expired. */
  async function useApproval(ctx: ToolContext, approvalId: string, tool: string, argsHash: string): Promise<string | null> {
    const used = await o.pool.query(
      `UPDATE tool_approvals SET status = 'used', used_at = now()
        WHERE id = $1 AND status = 'approved' AND expires_at > now()
          AND tenant_id = $2 AND session_id = $3 AND tool = $4 AND args_hash = $5`,
      [approvalId, ctx.tenantId, ctx.sessionId, tool, argsHash],
    );
    if (used.rowCount === 1) return null;
    const { rows } = await o.pool.query(
      `SELECT status, expires_at <= now() AS expired, tool = $2 AND args_hash = $3 AS same_call, tenant_id = $4 AND session_id = $5 AS same_session
         FROM tool_approvals WHERE id = $1`,
      [approvalId, tool, argsHash, ctx.tenantId, ctx.sessionId],
    );
    const r = rows[0];
    if (!r || !r.same_session) return 'no such approval for this session';
    if (!r.same_call) return 'the approval was given for a different call (tool or arguments changed)';
    if (r.status === 'used') return 'the approval was already used';
    if (r.status !== 'approved') return `the approval is ${r.status}`;
    return 'the approval has expired';
  }

  function session(s: ToolContext) {
    let untrusted = false;

    async function call(name: string, rawArgs: unknown, opts: { toolCallId?: string; approvalId?: string } = {}): Promise<CallResult> {
      const ctx = { ...s, untrusted };
      const tool = tools.get(name);
      if (!tool) {
        await audit(ctx, { tool: name, outcome: 'rejected', toolCallId: opts.toolCallId, detail: 'unknown tool' });
        return { status: 'rejected', reason: `unknown tool "${name}"` };
      }
      let args: Record<string, unknown>;
      try {
        args = validateArgs(tool, rawArgs);
      } catch (err) {
        await audit(ctx, { tool: name, tier: tool.tier, outcome: 'rejected', toolCallId: opts.toolCallId, detail: String((err as Error).message) });
        return { status: 'rejected', reason: (err as Error).message };
      }
      const argsHash = hashArgs(name, args);
      const base = { tool: name, tier: tool.tier, argsHash, toolCallId: opts.toolCallId };

      // Approval: always for destructive tools, and for writes once untrusted content is in the context.
      const reason =
        tool.tier === 'destructive' ? 'destructive tool' : tool.tier === 'write' && untrusted ? 'write tool after untrusted content entered the context' : null;
      if (reason) {
        if (!opts.approvalId) {
          const { rows } = await o.pool.query(
            `INSERT INTO tool_approvals (tenant_id, requested_by, session_id, tool, args, args_hash, reason, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8)) RETURNING id`,
            [s.tenantId, s.userId, s.sessionId, name, JSON.stringify(args), argsHash, reason, approvalTtlSec],
          );
          await audit(ctx, { ...base, outcome: 'approval_required', approvalId: rows[0].id, detail: reason });
          return { status: 'approval_required', approvalId: rows[0].id, reason };
        }
        const refused = await useApproval(s, opts.approvalId, name, argsHash);
        if (refused) {
          await audit(ctx, { ...base, outcome: 'rejected', approvalId: opts.approvalId, detail: refused });
          return { status: 'rejected', reason: refused };
        }
      }

      // Writes run once per tool-call id: claim it, or replay the stored result.
      const once = tool.tier !== 'read' && opts.toolCallId;
      if (once) {
        const claimed = await o.pool.query(
          `INSERT INTO tool_results (tenant_id, tool_call_id, tool, args_hash, status) VALUES ($1, $2, $3, $4, 'running')
           ON CONFLICT DO NOTHING`,
          [s.tenantId, opts.toolCallId, name, argsHash],
        );
        if (claimed.rowCount === 0) {
          const { rows } = await o.pool.query(`SELECT args_hash, status, result FROM tool_results WHERE tenant_id = $1 AND tool_call_id = $2`, [s.tenantId, opts.toolCallId]);
          const prior = rows[0];
          const refused = prior?.args_hash !== argsHash ? 'tool call id reused with different arguments' : prior.status !== 'done' ? 'this call is still running' : null;
          await audit(ctx, { ...base, outcome: refused ? 'rejected' : 'replayed', approvalId: opts.approvalId, detail: refused ?? undefined });
          return refused ? { status: 'rejected', reason: refused } : { status: 'ok', result: prior.result, replayed: true };
        }
      }
      try {
        const result = await tool.run(args, s);
        if (tool.returnsUntrusted) untrusted = true; // sticky: the model has now read text nobody vetted
        if (once) {
          await o.pool.query(`UPDATE tool_results SET status = 'done', result = $3 WHERE tenant_id = $1 AND tool_call_id = $2`, [
            s.tenantId,
            opts.toolCallId,
            JSON.stringify(result ?? null),
          ]);
        }
        await audit(ctx, { ...base, outcome: 'ok', approvalId: opts.approvalId });
        return { status: 'ok', result };
      } catch (err) {
        if (once) await o.pool.query(`DELETE FROM tool_results WHERE tenant_id = $1 AND tool_call_id = $2 AND status = 'running'`, [s.tenantId, opts.toolCallId]);
        const message = String(err instanceof Error ? err.message : err).slice(0, 500);
        await audit(ctx, { ...base, outcome: 'error', approvalId: opts.approvalId, detail: message });
        return { status: 'error', message };
      }
    }

    return {
      call,
      /** True once untrusted content reached the model in this session. */
      get untrusted() {
        return untrusted;
      },
      /** For content the app itself puts into the context: a pasted email, retrieved chunks, a fetched page. */
      markUntrusted() {
        untrusted = true;
      },
    };
  }

  /** Record a human decision. Returns false if the approval is gone, already decided, or this approver may not decide it. */
  async function decide(approvalId: string, approverId: string, decision: 'approved' | 'denied'): Promise<boolean> {
    const { rows } = await o.pool.query(`SELECT tool, requested_by FROM tool_approvals WHERE id = $1`, [approvalId]);
    if (!rows[0]) return false;
    if (tools.get(rows[0].tool)?.approvedBy === 'someone-else' && rows[0].requested_by === approverId) return false;
    const res = await o.pool.query(
      `UPDATE tool_approvals SET status = $3, decided_by = $2, decided_at = now()
        WHERE id = $1 AND status = 'pending' AND expires_at > now()`,
      [approvalId, approverId, decision],
    );
    return res.rowCount === 1;
  }

  /** JSON Schema for each tool, to hand to the model. The tier is part of the description. */
  function schemas() {
    return o.tools.map((t) => ({
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

  return { session, decide, schemas };
}
