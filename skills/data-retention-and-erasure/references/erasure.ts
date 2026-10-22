// Personal data lifecycle from one inventory: erasure requests (every table in one transaction, plus external
// stores retried until done), access requests (export), retention (batched deletes per table), and an audit
// that finds personal-looking columns the inventory doesn't cover.
// Table names, columns and SQL expressions come from the inventory, which is code, never request data.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from './pg-transaction.ts';

export interface InventoryEntry {
  table: string;
  /** Column holding the data subject's id (e.g. user_id). */
  subjectColumn: string;
  /** Personal-data columns of this table. Documents the inventory and feeds auditInventory(). */
  personal: string[];
  /**
   * On erasure: delete the rows, or keep them with personal fields overwritten (orders for accounting, audit
   * events). Entries run in order, so list children before their parents.
   */
  onErase: 'delete' | 'anonymize';
  /**
   * For 'anonymize': column → SQL expression for its new value, e.g. { email: "'erased'", user_id: 'NULL' }.
   * Must cover every `personal` column and the subject column, or the kept row still identifies the person.
   */
  anonymize?: Record<string, string>;
  /** Why rows survive erasure (the legal basis), recorded for the ADR and the record of processing. */
  keepReason?: string;
  /** Retention: rows older than this many days (by timeColumn) are deleted by runRetention(). */
  retentionDays?: number;
  timeColumn?: string;
}

/** A copy outside this database: a cache, a search index, traces, object storage, a vendor's API. */
export interface ExternalStore {
  name: string;
  /** Must be idempotent: it is retried until it succeeds, and may run again after a crash. */
  erase(subjectId: string): Promise<void>;
}

export interface DataLifecycleOptions {
  pool: pg.Pool;
  inventory: InventoryEntry[];
  stores?: ExternalStore[];
  /** Secret mixed into the subject hash kept after erasure. Keep it in the secret manager. */
  pepper: string;
  /** The deadline you committed to (GDPR: one month). Default 30. */
  dueDays?: number;
  /** How long one run may hold a request while it calls the external stores. Default 300 s. */
  leaseSec?: number;
}

const PERSONAL = new RegExp(
  '(^|_)(' +
    [
      'email', 'e_mail', 'phone', 'mobile', 'tel', 'full_name', 'first_name', 'last_name', 'display_name', 'address', 'street',
      'zip', 'postal_code', 'birth', 'birthday', 'dob', 'national_id', 'passport', 'ssn', 'tax_id', 'ip', 'ip_address',
      'user_agent', 'device_id', 'latitude', 'longitude', 'iban', 'card_number', 'account_number', 'salary', 'gender',
      // Vietnamese column names
      'cccd', 'cmnd', 'ho_ten', 'so_dien_thoai', 'sdt', 'dia_chi', 'ngay_sinh', 'gioi_tinh',
    ].join('|') +
    ')($|_)',
  'i',
);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * What is wrong with an inventory, or [] if nothing is. Checked at startup: an unsafe inventory would otherwise
 * show up as an erasure that fails on every request (a typo), or worse, one that "succeeds" and leaves personal
 * data behind.
 */
export function checkInventory(inventory: InventoryEntry[]): string[] {
  const problems: string[] = [];
  for (const e of inventory) {
    const names = [e.table, e.subjectColumn, ...e.personal, ...(e.timeColumn ? [e.timeColumn] : []), ...Object.keys(e.anonymize ?? {})];
    for (const n of names) if (!IDENT.test(n)) problems.push(`${e.table}: "${n}" is not a plain identifier`);
    if (e.onErase === 'anonymize') {
      const overwritten = new Set(Object.keys(e.anonymize ?? {}));
      for (const col of [...e.personal, e.subjectColumn]) {
        if (!overwritten.has(col)) problems.push(`${e.table}.${col} is kept as is on erasure: add it to anonymize`);
      }
    }
    if (e.retentionDays !== undefined && (!Number.isInteger(e.retentionDays) || e.retentionDays < 1 || !e.timeColumn)) {
      problems.push(`${e.table}: retentionDays needs a positive whole number of days and a timeColumn`);
    }
  }
  return problems;
}

type StoreState = Record<string, { status: 'pending' | 'done'; attempts: number; error?: string; done_at?: string }>;
/** A request this run holds the lease of. */
type Claim = { id: string; subject_id: string; stores: StoreState; lease_id: string };

export class DataLifecycle {
  readonly #pool: pg.Pool;
  readonly #inventory: InventoryEntry[];
  readonly #stores: ExternalStore[];
  readonly #pepper: string;
  readonly #dueDays: number;
  readonly #leaseSec: number;

  constructor(o: DataLifecycleOptions) {
    const problems = checkInventory(o.inventory);
    if (problems.length) throw new Error(`data lifecycle: unsafe inventory:\n  - ${problems.join('\n  - ')}`);
    if (!o.pepper) throw new Error('data lifecycle: a pepper is required');
    const names = (o.stores ?? []).map((s) => s.name);
    if (new Set(names).size !== names.length) throw new Error('data lifecycle: external store names must be unique');
    this.#pool = o.pool;
    this.#inventory = o.inventory;
    this.#stores = o.stores ?? [];
    this.#pepper = o.pepper;
    this.#dueDays = o.dueDays ?? 30;
    this.#leaseSec = o.leaseSec ?? 300;
  }

  /**
   * Erase one data subject. Every inventoried table is handled in one transaction, so a failure leaves nothing
   * half-erased. Then each external store is tried once; failures stay pending for processPending().
   */
  async requestErasure(subjectId: string): Promise<{ requestId: string; rows: Record<string, number>; pendingStores: string[] }> {
    const { claim, rows } = await withTransaction(this.#pool, async (tx) => {
      const rows: Record<string, number> = {};
      for (const e of this.#inventory) {
        const sql =
          e.onErase === 'delete'
            ? `DELETE FROM ${e.table} WHERE ${e.subjectColumn} = $1`
            : `UPDATE ${e.table} SET ${Object.entries(e.anonymize!).map(([col, expr]) => `${col} = ${expr}`).join(', ')} WHERE ${e.subjectColumn} = $1`;
        rows[e.table] = (await tx.query(sql, [subjectId])).rowCount ?? 0;
      }
      // Created holding a lease: a processPending() running elsewhere can't pick it up before this call's first try.
      const { rows: created } = await tx.query<Claim>(
        `INSERT INTO erasure_requests (subject_id, subject_hash, due_at, db_done_at, db_rows, stores, lease_id, locked_until)
         VALUES ($1, $2, now() + make_interval(days => $3), now(), $4, $5, gen_random_uuid(), now() + make_interval(secs => $6))
         RETURNING id, subject_id, stores, lease_id`,
        [
          subjectId,
          createHash('sha256').update(this.#pepper).update(subjectId).digest('hex'),
          this.#dueDays,
          JSON.stringify(rows),
          JSON.stringify(Object.fromEntries(this.#stores.map((s) => [s.name, { status: 'pending', attempts: 0 }]))),
          this.#leaseSec,
        ],
      );
      return { claim: created[0], rows };
    });
    const pendingStores = (await this.#process(claim)) ?? Object.keys(claim.stores);
    return { requestId: claim.id, rows, pendingStores };
  }

  /**
   * Retry the external stores of open requests. Run it on a schedule (job-queue) from any number of instances:
   * each request is leased to one run at a time. Alert on requests near due_at.
   */
  async processPending(limit = 100): Promise<{ completed: number; open: number }> {
    const { rows } = await this.#pool.query<Claim>(
      `UPDATE erasure_requests SET lease_id = gen_random_uuid(), locked_until = now() + make_interval(secs => $2)
        WHERE id IN (
          SELECT id FROM erasure_requests
          WHERE completed_at IS NULL AND (locked_until IS NULL OR locked_until < now())
          ORDER BY requested_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, subject_id, stores, lease_id`,
      [limit, this.#leaseSec],
    );
    let completed = 0;
    for (const claim of rows) if ((await this.#process(claim))?.length === 0) completed++;
    const { rows: open } = await this.#pool.query(`SELECT count(*)::int AS n FROM erasure_requests WHERE completed_at IS NULL`);
    return { completed, open: open[0].n };
  }

  /** Access request ("what do you have about me?"): every inventoried row about the subject, by table. */
  async exportSubject(subjectId: string): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const e of this.#inventory) {
      out[e.table] = (await this.#pool.query(`SELECT * FROM ${e.table} WHERE ${e.subjectColumn} = $1`, [subjectId])).rows;
    }
    return out;
  }

  /** Delete rows past their retention window, per table, in batches (short locks, bounded WAL). */
  async runRetention(batchSize = 5000): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    for (const e of this.#inventory) {
      if (!e.retentionDays || !e.timeColumn) continue;
      deleted[e.table] = 0;
      for (;;) {
        const res = await this.#pool.query(
          `DELETE FROM ${e.table} WHERE ctid = ANY(ARRAY(
             SELECT ctid FROM ${e.table} WHERE ${e.timeColumn} < now() - make_interval(days => $1) LIMIT $2))`,
          [e.retentionDays, batchSize],
        );
        deleted[e.table] += res.rowCount ?? 0;
        if ((res.rowCount ?? 0) < batchSize) break;
      }
    }
    return deleted;
  }

  /**
   * CI guard: columns whose name looks personal (email, phone, full_name, address, ip, cccd, so_dien_thoai…)
   * that the inventory doesn't list. A new table with an email column fails the build until someone decides what
   * erasure and retention mean for it. `reviewed` lists "table.column" names a human checked and found not
   * personal. Free-text columns (notes, message bodies, JSON payloads) can't be judged by name: inventory them
   * deliberately.
   */
  async auditInventory(opts: { schema?: string; ignoreTables?: string[]; reviewed?: string[] } = {}): Promise<Array<{ table: string; column: string }>> {
    const known = new Set([...this.#inventory.flatMap((e) => e.personal.map((c) => `${e.table}.${c}`)), ...(opts.reviewed ?? [])]);
    const { rows } = await this.#pool.query(
      `SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
        WHERE table_schema = $1 AND NOT (table_name = ANY($2))
        ORDER BY table_name, ordinal_position`,
      [opts.schema ?? 'public', opts.ignoreTables ?? ['erasure_requests']],
    );
    return rows.filter((r) => PERSONAL.test(r.column) && !known.has(`${r.table}.${r.column}`));
  }

  /**
   * Try every store not done yet, then write the outcome back, as the lease holder only: a run that outlived its
   * lease leaves the request to whoever holds it now. Returns the stores still pending, or null if the lease was lost.
   */
  async #process(claim: Claim): Promise<string[] | null> {
    const state: StoreState = { ...claim.stores };
    for (const store of this.#stores) {
      const s = state[store.name] ?? { status: 'pending', attempts: 0 };
      if (s.status === 'done') continue;
      try {
        await store.erase(claim.subject_id);
        state[store.name] = { status: 'done', attempts: s.attempts + 1, done_at: new Date().toISOString() };
      } catch (err) {
        state[store.name] = { status: 'pending', attempts: s.attempts + 1, error: String(err instanceof Error ? err.message : err).slice(0, 500) };
      }
    }
    const pending = Object.entries(state).filter(([, s]) => s.status !== 'done').map(([name]) => name);
    const done = pending.length === 0;
    const res = await this.#pool.query(
      `UPDATE erasure_requests
          SET stores = $3, lease_id = NULL, locked_until = NULL,
              completed_at = CASE WHEN $4 THEN now() END,
              subject_id = CASE WHEN $4 THEN NULL ELSE subject_id END
        WHERE id = $1 AND lease_id = $2`,
      [claim.id, claim.lease_id, JSON.stringify(state), done],
    );
    return res.rowCount === 1 ? pending : null;
  }
}

export const createDataLifecycle = (o: DataLifecycleOptions) => new DataLifecycle(o);
