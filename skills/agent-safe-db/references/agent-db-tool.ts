// Trusted executor for agent DB tools.
// The LLM chooses a tool name + params; everything security-relevant (SQL text, tenant,
// timeouts, row cap, audit) is decided here. Adapt the tool list to your domain.
import pg from 'pg';
import { callHook } from './hooks.ts';
import { withTransaction } from './pg-transaction.ts';

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

/**
 * An ISO date that exists. Date.parse alone is lenient: '2026-02-31' becomes March 3, while Postgres refuses it, so
 * the model would see a database error instead of a clear parameter error.
 */
function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

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
        if (typeof v !== 'string' || !isRealDate(v)) throw new ToolInputError(`${p.name} must be an ISO date that exists`);
        return v;
      case 'string':
        if (typeof v !== 'string') throw new ToolInputError(`${p.name} must be a string`);
        if (v.length > (p.maxLength ?? 200)) throw new ToolInputError(`${p.name} is too long`);
        // Postgres text can't hold U+0000: tell the model, instead of failing in the database.
        if (v.includes('\u0000')) throw new ToolInputError(`${p.name} must not contain NUL characters`);
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
  /**
   * Records every call, sync or async (an insert into an audit table). It is awaited: a call it can't record fails,
   * so nothing reaches the model unaudited, and a rejected promise never goes unhandled.
   */
  audit: (entry: AuditEntry) => unknown;
  statementTimeoutMs?: number; // default 2000
  maxRows?: number; // default 200
  poolSize?: number; // default 5 — stay under the role's CONNECTION LIMIT
  /**
   * How long getting a connection may take (default 3000 ms). Without it, a database that accepts the TCP
   * connection but never answers (a failover, a black-holed network) hangs every tool call forever.
   */
  connectTimeoutMs?: number;
  /** Errors of idle pooled connections (the server ended one). Without a listener they would crash the process. */
  onError?: (err: Error) => unknown;
}

export interface ToolRunResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/** The longest timer Node can schedule (it runs a longer one after 1 ms), and the largest statement_timeout. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A count or a duration from the options: a positive integer. From an unset environment variable it would be NaN; a
 * duration past MAX_TIMER_MS would time every call out after 1 ms.
 */
function positiveInt(name: string, v: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(v) || v < 1 || v > max) throw new RangeError(`agent db: ${name} must be an integer from 1 to ${max}, got ${v}`);
  return v;
}

/**
 * The tool's SQL ends up inside `SELECT * FROM (…) AS q LIMIT n`, where a trailing semicolon is a syntax error on
 * every call. (A trailing `-- comment` is fine: the subquery is closed on the next line.)
 */
const TRAILING_SEMICOLON = /;\s*(?:--[^\n]*\s*)*$/;

/** Runs the developer-written tools as the agent role: read-only, tenant-scoped, time-boxed, row-capped, audited. */

export class AgentDb {
  readonly #pool: pg.Pool;
  readonly #tools: Record<string, ToolDef>;
  readonly #audit: (entry: AuditEntry) => unknown;
  readonly #timeoutMs: number;
  readonly #maxRows: number;

  constructor(o: AgentDbOptions) {
    this.#tools = o.tools;
    this.#audit = o.audit;
    // The client-side query_timeout below is this plus a second, and Node can't schedule a timer past MAX_TIMER_MS.
    this.#timeoutMs = positiveInt('statementTimeoutMs', o.statementTimeoutMs ?? 2000, MAX_TIMER_MS - 1000);
    // NaN here made every call a syntax error (LIMIT NaN); a pool of NaN or a connect timeout of 0 never times out.
    this.#maxRows = positiveInt('maxRows', o.maxRows ?? 200);
    for (const [name, tool] of Object.entries(o.tools)) {
      if (tool.maxRows !== undefined) positiveInt(`${name}.maxRows`, tool.maxRows);
      if (TRAILING_SEMICOLON.test(tool.sql)) throw new Error(`agent db: ${name}: its SQL ends with a semicolon, a syntax error once it is wrapped as a subquery`);
    }
    this.#pool = new pg.Pool({
      connectionString: o.connectionString,
      max: positiveInt('poolSize', o.poolSize ?? 5),
      connectionTimeoutMillis: positiveInt('connectTimeoutMs', o.connectTimeoutMs ?? 3000, MAX_TIMER_MS),
      // The server-side statement_timeout limits the query; this limits the wait for its answer over a slow network.
      query_timeout: this.#timeoutMs + 1000,
      application_name: 'agent-db', // find the agent's sessions in pg_stat_activity
    });
    // Inside an 'error' event: a hook that throws here would be an uncaught exception, the crash this listener prevents.
    this.#pool.on('error', (err) => callHook(o.onError, err));
  }

  async run(toolName: string, rawParams: unknown, ctx: CallContext): Promise<ToolRunResult> {
    const started = performance.now();
    const base = {
      tool: toolName,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      traceId: ctx.traceId,
      params: (rawParams ?? {}) as Record<string, unknown>,
    };
    // Awaited, sync or async: if the entry can't be recorded, that failure is the call's answer (fail closed).
    const audit = (entry: AuditEntry) => Promise.resolve().then(() => this.#audit(entry));
    const fail = async (error: unknown): Promise<never> => {
      await audit({
        ...base,
        ok: false,
        rowCount: 0,
        truncated: false,
        durationMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    };

    const tool = Object.hasOwn(this.#tools, toolName) ? this.#tools[toolName] : undefined;
    if (!tool) return fail(new ToolInputError(`unknown tool: ${toolName}`));
    if (!UUID_RE.test(ctx.tenantId)) return fail(new ToolInputError('invalid tenant context'));

    let values: unknown[];
    try {
      values = coerceParams(tool, rawParams ?? {});
    } catch (e) {
      return fail(e);
    }

    const maxRows = Math.min(tool.maxRows ?? this.#maxRows, this.#maxRows);
    let res: pg.QueryResult;
    try {
      res = await withTransaction(
        this.#pool,
        // Fetch one extra row to know whether we truncated. The line breaks keep a trailing `-- comment` in the tool's
        // SQL from swallowing the closing parenthesis: the call was a syntax error every time.
        (tx) => tx.query(`SELECT * FROM (\n${tool.sql}\n) AS q LIMIT ${maxRows + 1}`, values),
        // BEGIN and both settings in one round trip instead of two (a parameterized query can't share a call with
        // BEGIN). Inlining is safe only because the tenant id passed UUID_RE above and the timeout is an integer
        // checked at startup: nothing else can be in this string. Never inline a value that hasn't passed a check
        // this strict.
        { begin: `BEGIN READ ONLY; SELECT set_config('app.tenant_id', '${ctx.tenantId}', true), set_config('statement_timeout', '${this.#timeoutMs}', true)` },
      );
    } catch (e) {
      return fail(e);
    }
    const truncated = res.rows.length > maxRows;
    const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
    await audit({ ...base, ok: true, rowCount: rows.length, truncated, durationMs: performance.now() - started });
    return { rows, truncated };
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}

export const createAgentDb = (o: AgentDbOptions) => new AgentDb(o);
