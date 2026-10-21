// Trusted executor for agent DB tools.
// The LLM chooses a tool name + params; everything security-relevant (SQL text, tenant,
// timeouts, row cap, audit) is decided here. Adapt the tool list to your domain.
import pg from 'pg';

export type ParamType = 'string' | 'number' | 'uuid' | 'date';

export interface ParamDef {
  name: string;
  type: ParamType;
  description: string;
  required?: boolean; // default true
  maxLength?: number; // strings; default 200
}

export interface ToolDef {
  description: string;
  /** Developer-written SQL against agent_api views. Params are $1..$n in `params` order. */
  sql: string;
  params: ParamDef[];
  maxRows?: number;
}

export interface CallContext {
  /** From the authenticated session — never from model output. */
  tenantId: string;
  userId: string;
  traceId?: string;
}

export interface AuditEntry {
  tool: string;
  tenantId: string;
  userId: string;
  traceId?: string;
  params: Record<string, unknown>;
  ok: boolean;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  error?: string;
}

export class ToolInputError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

// Example tools. Keep them narrow: one question each, small result sets.
export const exampleTools = {
  list_recent_orders: {
    description: 'List the most recent orders for the current workspace, optionally filtered by status.',
    sql: `SELECT id, customer_id, status, total_amount, created_at
          FROM agent_api.orders
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY created_at DESC`,
    params: [{ name: 'status', type: 'string', description: 'Order status, e.g. "paid"', required: false, maxLength: 32 }],
    maxRows: 50,
  },
  get_customer_orders: {
    description: 'Orders of one customer in the current workspace.',
    sql: `SELECT id, status, total_amount, created_at
          FROM agent_api.orders
          WHERE customer_id = $1
          ORDER BY created_at DESC`,
    params: [{ name: 'customer_id', type: 'uuid', description: 'Customer id' }],
  },
  find_customers_by_city: {
    description: 'Customers (masked contact info) in a city.',
    sql: `SELECT id, email_masked, phone_masked, city FROM agent_api.customers WHERE city = $1`,
    params: [{ name: 'city', type: 'string', description: 'City name', maxLength: 80 }],
  },
} satisfies Record<string, ToolDef>;

function coerceParams(tool: ToolDef, raw: unknown): unknown[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolInputError('params must be an object');
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(tool.params.map((p) => p.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new ToolInputError(`unknown param: ${key}`);
  }
  return tool.params.map((p) => {
    const v = input[p.name];
    if (v === undefined || v === null) {
      if (p.required === false) return null;
      throw new ToolInputError(`missing param: ${p.name}`);
    }
    switch (p.type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolInputError(`${p.name} must be a number`);
        return v;
      case 'uuid':
        if (typeof v !== 'string' || !UUID_RE.test(v)) throw new ToolInputError(`${p.name} must be a uuid`);
        return v;
      case 'date':
        if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
          throw new ToolInputError(`${p.name} must be an ISO date`);
        }
        return v;
      case 'string':
        if (typeof v !== 'string') throw new ToolInputError(`${p.name} must be a string`);
        if (v.length > (p.maxLength ?? 200)) throw new ToolInputError(`${p.name} is too long`);
        return v;
    }
  });
}

/** JSON-schema tool definitions for the LLM, generated from the same source of truth. */
export function toToolSchemas(tools: Record<string, ToolDef>) {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        t.params.map((p) => [
          p.name,
          p.type === 'number'
            ? { type: 'number', description: p.description }
            : {
                type: 'string',
                description: p.description,
                ...(p.type === 'uuid' ? { format: 'uuid' } : {}),
                ...(p.type === 'date' ? { format: 'date-time' } : {}),
                ...(p.type === 'string' ? { maxLength: p.maxLength ?? 200 } : {}),
              },
        ]),
      ),
      required: t.params.filter((p) => p.required !== false).map((p) => p.name),
    },
  }));
}

export interface AgentDbOptions {
  /** Connection string for the agent_app role (read replica if you have one). */
  connectionString: string;
  tools: Record<string, ToolDef>;
  audit: (entry: AuditEntry) => void;
  statementTimeoutMs?: number; // default 2000
  maxRows?: number; // default 200
  poolSize?: number; // default 5 — stay under the role's CONNECTION LIMIT
}

export function createAgentDb(opts: AgentDbOptions) {
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.poolSize ?? 5 });
  const timeoutMs = opts.statementTimeoutMs ?? 2000;

  async function run(toolName: string, rawParams: unknown, ctx: CallContext) {
    const started = performance.now();
    const base = {
      tool: toolName,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      traceId: ctx.traceId,
      params: (rawParams ?? {}) as Record<string, unknown>,
    };
    const fail = (error: unknown): never => {
      opts.audit({
        ...base,
        ok: false,
        rowCount: 0,
        truncated: false,
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    };

    const tool = Object.hasOwn(opts.tools, toolName) ? opts.tools[toolName] : undefined;
    if (!tool) return fail(new ToolInputError(`unknown tool: ${toolName}`));
    if (!UUID_RE.test(ctx.tenantId)) return fail(new ToolInputError('invalid tenant context'));

    let values: unknown[];
    try {
      values = coerceParams(tool, rawParams ?? {});
    } catch (e) {
      return fail(e);
    }

    const maxRows = Math.min(tool.maxRows ?? opts.maxRows ?? 200, opts.maxRows ?? 200);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)`,
        [ctx.tenantId, String(timeoutMs)],
      );
      // Fetch one extra row to know whether we truncated.
      const res = await client.query(`SELECT * FROM (${tool.sql}) AS q LIMIT ${maxRows + 1}`, values);
      await client.query('COMMIT');
      const truncated = res.rows.length > maxRows;
      const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
      opts.audit({ ...base, ok: true, rowCount: rows.length, truncated, durationMs: performance.now() - started });
      return { rows, truncated };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(e);
    } finally {
      client.release();
    }
  }

  return { run, close: () => pool.end() };
}
