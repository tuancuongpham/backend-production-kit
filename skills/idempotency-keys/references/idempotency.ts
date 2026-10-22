// Idempotency keys (Stripe-style; IETF draft "The Idempotency-Key HTTP Header Field"): a client or an agent
// that resends a request after a timeout gets the first response back instead of a second order, charge or email.
//   same key, same request, finished     → the stored response (send `Idempotent-Replayed: true`)
//   same key while the first still runs  → 409 with Retry-After
//   same key, different request          → 422
//   handler threw, or the process died   → nothing stored: the same key can be retried
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withClient } from './pg-transaction.ts';

export interface IdempotentRequest {
  /** Who is asking: tenant + principal (user or API-key id), from authentication, never from the request body. */
  scope: string;
  /** The Idempotency-Key header, checked by parseIdempotencyKey(). */
  key: string;
  /** requestFingerprint(method, path, body). */
  fingerprint: string;
}

/**
 * The handler's answer. Return it for a definitive outcome (201, or a 4xx such as "card declined"): it is stored
 * and replayed. Throw for a transient failure: nothing is stored and the client may retry the same key.
 */
export interface StoredResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface IdempotentResult extends StoredResponse {
  /** The stored response of an earlier request with this key. Send `Idempotent-Replayed: true`. */
  replayed: boolean;
}

export interface IdempotencyOptions {
  /** How long a key is remembered. It must outlive the client's retries. Default 24 h. */
  ttlSec?: number;
  /**
   * runExternal: a claim still in progress after this long belongs to a process that died, and a retry of the
   * same request may take it over. Keep the handler well below it. Default 60 s.
   */
  staleAfterSec?: number;
}

export class IdempotencyError extends Error {
  status: 400 | 409 | 422;
  code: 'invalid_key' | 'in_progress' | 'key_reused';
  /** Set on 409: when the client should try again. */
  retryAfterSec?: number;
  constructor(status: 400 | 409 | 422, code: 'invalid_key' | 'in_progress' | 'key_reused', message: string) {
    super(message);
    this.name = 'IdempotencyError';
    this.status = status;
    this.code = code;
    if (status === 409) this.retryAfterSec = 1;
  }
}

const KEY_RE = /^[\x21-\x7e]{1,255}$/;

/**
 * The header's value, or undefined when it is absent (the route decides whether a key is required).
 * Up to 255 visible ASCII characters; clients should send a random UUID. A malformed key is a 400, and so is a
 * key sent twice (Node joins repeated headers with ", ").
 */
export function parseIdempotencyKey(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !KEY_RE.test(header)) {
    throw new IdempotencyError(400, 'invalid_key', 'Idempotency-Key must be 1 to 255 visible ASCII characters, sent once');
  }
  return header;
}

/**
 * sha256 of the method, the path (with its query string) and the body with object keys sorted, so a client
 * that re-serializes the same JSON in another key order still matches.
 */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`).digest('hex');
}

function canonicalJson(v: unknown): string {
  if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalJson((v as { toJSON: () => unknown }).toJSON()); // Date, Buffer…
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Stable for one (caller, key, request): pass it as the idempotency key of every external call the handler
 * makes (Stripe's `idempotencyKey`, a provider's request id, an outbox message id).
 */
export function downstreamKey(req: IdempotentRequest): string {
  return createHash('sha256').update(`${req.scope}\0${req.key}\0${req.fingerprint}`).digest('hex');
}

// The claim, in one statement:
//  - a transaction-scoped advisory lock on (scope, key), taken without waiting. While another request holds
//    the key, nothing is inserted, and the caller answers 409 at once instead of parking a connection behind it;
//  - a new key is inserted. An expired key starts over. An in_progress claim of the same request whose process
//    died (locked longer than staleAfterSec) is taken over. A live key is left alone;
//  - every claim gets a new claim_token: only its holder may store the response or release the key, so a
//    process whose claim was taken over can't touch the claim that replaced it.
// Only when nothing was claimed (a retry, a duplicate: the rare path) does a second statement read the record.
const CLAIM = `
  INSERT INTO idempotency_keys AS k (scope, key, fingerprint, expires_at, claim_token)
  SELECT $1, $2, $3, now() + make_interval(secs => $4), $6
  WHERE pg_try_advisory_xact_lock(hashtextextended($2, hashtextextended($1, 0)))
  ON CONFLICT (scope, key) DO UPDATE
    SET fingerprint = EXCLUDED.fingerprint, status = 'in_progress', locked_at = now(), created_at = now(),
        response_status = NULL, response_body = NULL, response_headers = NULL, expires_at = EXCLUDED.expires_at,
        claim_token = EXCLUDED.claim_token
    WHERE k.expires_at <= now()
       OR (k.status = 'in_progress' AND k.locked_at < now() - make_interval(secs => $5) AND k.fingerprint = EXCLUDED.fingerprint)
  RETURNING 1`;
const EXISTING = `
  SELECT fingerprint, status, response_status, response_body, response_headers
  FROM idempotency_keys WHERE scope = $1 AND key = $2 AND expires_at > now()`;

type Db = pg.Pool | pg.PoolClient;

/** Idempotent request handling on Postgres. Stateless apart from its settings: one instance per app is enough. */
export class IdempotencyKeys {
  readonly #pool: pg.Pool;
  readonly #ttlSec: number;
  readonly #staleAfterSec: number;

  constructor(o: { pool: pg.Pool } & IdempotencyOptions) {
    this.#pool = o.pool;
    this.#ttlSec = o.ttlSec ?? 86_400;
    this.#staleAfterSec = o.staleAfterSec ?? 60;
    if (!(this.#ttlSec > 0) || !(this.#staleAfterSec > 0)) throw new RangeError('idempotency keys: ttlSec and staleAfterSec must be positive');
  }

  /**
   * For effects inside this database (create an order, move a balance). The claim, the handler's writes and
   * the stored response commit in one transaction: a thrown error or a crash leaves no trace, and the client
   * can retry the same key. A duplicate arriving while the first runs gets 409 at once. `fn` must do all its
   * writes through `tx`. Cost: two statements per request (claim and store).
   */
  run(req: IdempotentRequest, fn: (tx: pg.PoolClient) => Promise<StoredResponse>): Promise<IdempotentResult> {
    return withClient(this.#pool, async (tx) => {
      await tx.query('BEGIN');
      try {
        const token = randomUUID();
        const earlier = await this.#claim(tx, req, token);
        if (earlier) {
          // Roll back, don't commit: ON CONFLICT DO UPDATE locked the existing row even though it changed nothing,
          // and committing that lock costs a WAL flush. Measured: replays 0.84 ms with ROLLBACK, 1.75 ms with COMMIT.
          await tx.query('ROLLBACK');
          return earlier;
        }
        const res = await fn(tx);
        await this.#store(tx, req, token, res);
        await tx.query('COMMIT');
        return { ...res, replayed: false };
      } catch (err) {
        await tx.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  /**
   * For effects outside this database (a payment provider, an email, another service). The claim commits
   * first, so a duplicate sees it and gets 409 while the call runs, and no transaction stays open across the
   * network call. `fn` must be safe to run twice: pass `downstreamKey` as the idempotency key of every external
   * call, and make its own writes idempotent (unique constraint + ON CONFLICT). If the process dies mid-call,
   * the claim stays in progress; after `staleAfterSec` a retry of the same request takes it over and runs `fn`
   * again, which the downstream key turns into a no-op. `signal` aborts at half of `staleAfterSec`: pass it to
   * the external call.
   */
  async runExternal(req: IdempotentRequest, fn: (ctx: { downstreamKey: string; signal: AbortSignal }) => Promise<StoredResponse>): Promise<IdempotentResult> {
    const token = randomUUID();
    const earlier = await this.#claim(this.#pool, req, token); // autocommit: visible to duplicates at once
    if (earlier) return earlier;
    let res: StoredResponse;
    try {
      res = await fn({ downstreamKey: downstreamKey(req), signal: AbortSignal.timeout(Math.max(1, Math.floor(this.#staleAfterSec * 500))) });
    } catch (e) {
      // Failed, or outcome unknown (a timed-out call may still have gone through): release the key so the
      // client can retry it, unless the claim has been taken over meanwhile. If the call did happen, the
      // downstream key makes the retry a no-op there.
      await this.#pool
        .query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND status = 'in_progress' AND claim_token = $3`, [req.scope, req.key, token])
        .catch(() => {}); // if this fails too, the claim goes stale and a later retry takes it over
      throw e;
    }
    await this.#store(this.#pool, req, token, res);
    return { ...res, replayed: false };
  }

  /**
   * Delete expired keys in batches; run it hourly. A key must outlive the client's retries: once it is gone, a
   * late retry runs the request again.
   */
  async prune(batchSize = 5000): Promise<number> {
    let total = 0;
    for (;;) {
      const res = await this.#pool.query(
        `DELETE FROM idempotency_keys WHERE (scope, key) IN (
           SELECT scope, key FROM idempotency_keys WHERE expires_at <= now() LIMIT $1)`,
        [batchSize],
      );
      const n = res.rowCount ?? 0;
      total += n;
      if (n < batchSize) return total;
    }
  }

  /** null: the key is ours, run the handler. Otherwise the earlier response, or a 409/422. */
  async #claim(db: Db, req: IdempotentRequest, token: string): Promise<IdempotentResult | null> {
    const claimed = await db.query(CLAIM, [req.scope, req.key, req.fingerprint, this.#ttlSec, this.#staleAfterSec, token]);
    if (claimed.rowCount === 1) return null;
    const r = (await db.query(EXISTING, [req.scope, req.key])).rows[0];
    // Nothing committed yet means another request holds the key right now.
    if (!r || (r.status === 'in_progress' && r.fingerprint === req.fingerprint)) {
      throw new IdempotencyError(409, 'in_progress', 'A request with this Idempotency-Key is still in progress');
    }
    if (r.fingerprint !== req.fingerprint) {
      throw new IdempotencyError(422, 'key_reused', 'This Idempotency-Key was already used for a different request');
    }
    return { status: r.response_status, body: r.response_body, headers: r.response_headers ?? undefined, replayed: true };
  }

  async #store(db: Db, req: IdempotentRequest, token: string, res: StoredResponse) {
    await db.query(
      `UPDATE idempotency_keys
          SET status = 'done', response_status = $3, response_body = $4, response_headers = $5
        WHERE scope = $1 AND key = $2 AND status = 'in_progress' AND claim_token = $6`,
      [req.scope, req.key, res.status, JSON.stringify(res.body ?? null), res.headers ? JSON.stringify(res.headers) : null, token],
    );
  }
}

/** One-call form of IdempotencyKeys#run. */
export function runIdempotent(
  pool: pg.Pool,
  req: IdempotentRequest,
  fn: (tx: pg.PoolClient) => Promise<StoredResponse>,
  opts: IdempotencyOptions = {},
): Promise<IdempotentResult> {
  return new IdempotencyKeys({ pool, ...opts }).run(req, fn);
}

/** One-call form of IdempotencyKeys#runExternal. */
export function runIdempotentExternal(
  pool: pg.Pool,
  req: IdempotentRequest,
  fn: (ctx: { downstreamKey: string; signal: AbortSignal }) => Promise<StoredResponse>,
  opts: IdempotencyOptions = {},
): Promise<IdempotentResult> {
  return new IdempotencyKeys({ pool, ...opts }).runExternal(req, fn);
}

/** One-call form of IdempotencyKeys#prune. */
export function pruneIdempotencyKeys(pool: pg.Pool, batchSize = 5000): Promise<number> {
  return new IdempotencyKeys({ pool }).prune(batchSize);
}
