// Personal data lifecycle from one inventory: erasure requests (every table in one transaction, plus external
// stores retried until done), access requests (export), retention (batched deletes per table), and an audit
// that finds personal-looking columns the inventory doesn't cover.
// Table names, columns and SQL expressions come from the inventory, which is code, never request data.
import { createHash } from 'node:crypto';
import type pg from 'pg';

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
  /** For 'anonymize': column → SQL expression for its new value, e.g. { email: "'erased'", user_id: 'NULL' }. */
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
  erase(subjectId: string): Promise<void>;
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

export function createDataLifecycle(o: { pool: pg.Pool; inventory: InventoryEntry[]; stores?: ExternalStore[]; pepper: string; dueDays?: number }) {
  const stores = o.stores ?? [];
  const hash = (subjectId: string) => createHash('sha256').update(o.pepper).update(subjectId).digest('hex');

  /**
   * Erase one data subject. Every inventoried table is handled in one transaction, so a failure leaves nothing
   * half-erased. Then each external store is tried once; failures stay pending for processPending().
   */
  async function requestErasure(subjectId: string): Promise<{ requestId: string; rows: Record<string, number>; pendingStores: string[] }> {
    const client = await o.pool.connect();
    let lost: Error | undefined; // a connection dying mid-transaction fails the request, not the process
    const onLost = (err: Error) => {
      lost = err;
    };
    client.on('error', onLost);
    let requestId: string;
    const rows: Record<string, number> = {};
    try {
      await client.query('BEGIN');
      for (const e of o.inventory) {
        const sql =
          e.onErase === 'delete'
            ? `DELETE FROM ${e.table} WHERE ${e.subjectColumn} = $1`
            : `UPDATE ${e.table} SET ${Object.entries(e.anonymize ?? {}).map(([col, expr]) => `${col} = ${expr}`).join(', ')} WHERE ${e.subjectColumn} = $1`;
        rows[e.table] = (await client.query(sql, [subjectId])).rowCount ?? 0;
      }
      const { rows: created } = await client.query(
        `INSERT INTO erasure_requests (subject_id, subject_hash, due_at, db_done_at, db_rows, stores)
         VALUES ($1, $2, now() + make_interval(days => $3), now(), $4, $5) RETURNING id`,
        [
          subjectId,
          hash(subjectId),
          o.dueDays ?? 30,
          JSON.stringify(rows),
          JSON.stringify(Object.fromEntries(stores.map((s) => [s.name, { status: 'pending', attempts: 0 }]))),
        ],
      );
      requestId = created[0].id;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.off('error', onLost);
      client.release(lost);
    }
    await processRequest(requestId);
    const { rows: after } = await o.pool.query(`SELECT stores FROM erasure_requests WHERE id = $1`, [requestId]);
    const pendingStores = Object.entries(after[0].stores as Record<string, { status: string }>).filter(([, s]) => s.status !== 'done').map(([n]) => n);
    return { requestId, rows, pendingStores };
  }

  async function processRequest(requestId: string) {
    const { rows } = await o.pool.query(`SELECT subject_id, stores FROM erasure_requests WHERE id = $1 AND completed_at IS NULL`, [requestId]);
    if (!rows[0]) return;
    const state = rows[0].stores as Record<string, { status: string; attempts: number; error?: string; done_at?: string }>;
    for (const store of stores) {
      const s = state[store.name] ?? { status: 'pending', attempts: 0 };
      if (s.status === 'done') continue;
      try {
        await store.erase(rows[0].subject_id);
        state[store.name] = { status: 'done', attempts: s.attempts + 1, done_at: new Date().toISOString() };
      } catch (err) {
        state[store.name] = { status: 'pending', attempts: s.attempts + 1, error: String(err instanceof Error ? err.message : err).slice(0, 500) };
      }
    }
    const done = Object.values(state).every((s) => s.status === 'done');
    await o.pool.query(
      `UPDATE erasure_requests
          SET stores = $2,
              completed_at = CASE WHEN $3 THEN now() END,
              subject_id = CASE WHEN $3 THEN NULL ELSE subject_id END
        WHERE id = $1`,
      [requestId, JSON.stringify(state), done],
    );
  }

  /** Retry external stores of open requests. Run it on a schedule (job-queue) and alert on requests near due_at. */
  async function processPending(): Promise<{ completed: number; open: number }> {
    const { rows } = await o.pool.query(`SELECT id FROM erasure_requests WHERE completed_at IS NULL ORDER BY requested_at LIMIT 100`);
    for (const r of rows) await processRequest(r.id);
    const { rows: open } = await o.pool.query(`SELECT count(*)::int AS n FROM erasure_requests WHERE completed_at IS NULL`);
    return { completed: rows.length - open[0].n, open: open[0].n };
  }

  /** Access request ("what do you have about me?"): every inventoried row about the subject, by table. */
  async function exportSubject(subjectId: string): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const e of o.inventory) {
      out[e.table] = (await o.pool.query(`SELECT * FROM ${e.table} WHERE ${e.subjectColumn} = $1`, [subjectId])).rows;
    }
    return out;
  }

  /** Delete rows past their retention window, per table, in batches (short locks, bounded WAL). */
  async function runRetention(batchSize = 5000): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    for (const e of o.inventory) {
      if (!e.retentionDays || !e.timeColumn) continue;
      deleted[e.table] = 0;
      for (;;) {
        const res = await o.pool.query(
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
  async function auditInventory(opts: { schema?: string; ignoreTables?: string[]; reviewed?: string[] } = {}): Promise<Array<{ table: string; column: string }>> {
    const known = new Set([...o.inventory.flatMap((e) => e.personal.map((c) => `${e.table}.${c}`)), ...(opts.reviewed ?? [])]);
    const { rows } = await o.pool.query(
      `SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
        WHERE table_schema = $1 AND NOT (table_name = ANY($2))
        ORDER BY table_name, ordinal_position`,
      [opts.schema ?? 'public', opts.ignoreTables ?? ['erasure_requests']],
    );
    return rows.filter((r) => PERSONAL.test(r.column) && !known.has(`${r.table}.${r.column}`));
  }

  return { requestErasure, processPending, exportSubject, runRetention, auditInventory };
}
