import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, readSkillFile, runSqlFile, withUser } from '../support/infra.ts';
import { fakeEmbedding, toVectorLiteral } from '../support/vectors.ts';
import { hybridSearch, withTenant } from '../../../skills/multitenant-postgres/references/tenant-db.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let admin: pg.Client;
let pool: pg.Pool;
let docA: string;
let docB: string;

async function auditRows(): Promise<{ leaks: any[]; bypass: any[]; unfiltered: any[] }> {
  const res = (await admin.query(await readSkillFile('multitenant-postgres', 'rls-audit.sql'))) as unknown as pg.QueryResult[];
  return { leaks: res[0].rows, bypass: res[1].rows, unfiltered: res[2].rows };
}

describe('multitenant-postgres', () => {
  before(async () => {
    const dbUrl = await freshDatabase('kit_multitenant');
    admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    await runSqlFile(admin, 'multitenant-postgres', 'schema.sql');
    await runSqlFile(admin, 'multitenant-postgres', 'schema.sql'); // idempotent
    await admin.query(`ALTER ROLE app_user PASSWORD 'app-test-pw'`);
    await admin.query(`INSERT INTO tenants (id, name) VALUES ('${A}', 'Acme'), ('${B}', 'Beta')`);
    pool = new pg.Pool({ connectionString: withUser(dbUrl, 'app_user', 'app-test-pw'), max: 4 });

    const seed = async (tenant: string, rows: Array<[string, number]>) =>
      withTenant(pool, tenant, async (c) => {
        const doc = (await c.query(`INSERT INTO documents (title) VALUES ('Help center') RETURNING id`)).rows[0].id;
        for (const [content, seedNo] of rows) {
          await c.query(`INSERT INTO chunks (document_id, content, embedding) VALUES ($1, $2, $3)`, [
            doc,
            content,
            toVectorLiteral(fakeEmbedding(seedNo)),
          ]);
        }
        return doc as string;
      });

    docA = await seed(A, [
      ['Hướng dẫn thanh toán qua VNPay và MoMo', 1],
      ['Chính sách đổi trả trong 30 ngày', 2],
      ['Cách đặt lại mật khẩu tài khoản', 3],
    ]);
    docB = await seed(B, [
      ['Hướng dẫn thanh toán qua VNPay và MoMo', 1], // identical content in another tenant
      ['Beta secret roadmap', 4],
    ]);
  });

  after(async () => {
    await pool?.end();
    await admin?.end();
  });

  it('each tenant sees only its own rows', async () => {
    const countA = await withTenant(pool, A, async (c) => (await c.query('SELECT count(*)::int n FROM chunks')).rows[0].n);
    const countB = await withTenant(pool, B, async (c) => (await c.query('SELECT count(*)::int n FROM chunks')).rows[0].n);
    assert.equal(countA, 3);
    assert.equal(countB, 2);
  });

  it('no tenant context means no rows (fail closed), even for a non-superuser table owner', async () => {
    const c = await pool.connect();
    assert.equal((await c.query('SELECT count(*)::int n FROM chunks')).rows[0].n, 0);
    c.release();

    // FORCE RLS covers the owner — but superusers always bypass RLS, so test with a plain owner role.
    await admin.query(`DROP ROLE IF EXISTS kit_owner; CREATE ROLE kit_owner; ALTER TABLE chunks OWNER TO kit_owner`);
    await admin.query('SET ROLE kit_owner');
    try {
      assert.equal((await admin.query('SELECT count(*)::int n FROM chunks')).rows[0].n, 0);
    } finally {
      await admin.query('RESET ROLE');
      await admin.query(`ALTER TABLE chunks OWNER TO CURRENT_USER`);
    }
    // ...whereas the superuser sees everything: never let the app connect as one.
    assert.equal((await admin.query('SELECT count(*)::int n FROM chunks')).rows[0].n, 5);
  });

  it('tenant context does not leak to the next use of a pooled connection', async () => {
    await withTenant(pool, A, async () => {});
    const c = await pool.connect();
    assert.equal((await c.query(`SELECT current_tenant_id() AS t`)).rows[0].t, null);
    c.release();
  });

  it('rejects a malformed tenant id before any SQL runs (withTenant inlines the checked id)', async () => {
    let called = false;
    for (const bad of [`${A}'; DROP TABLE documents; --`, `${A}\n`, `' OR '1'='1`, `${A}'`, '']) {
      await assert.rejects(
        withTenant(pool, bad, async () => {
          called = true;
        }),
        /invalid tenant id/,
      );
    }
    assert.equal(called, false);
    assert.equal((await admin.query(`SELECT to_regclass('documents') IS NOT NULL AS ok`)).rows[0].ok, true);
    // Upper-case ids are valid UUIDs and still select the right tenant.
    const n = await withTenant(pool, A.toUpperCase(), async (c) => (await c.query('SELECT count(*)::int n FROM chunks')).rows[0].n);
    assert.equal(n, 3);
  });

  it('cannot insert rows for another tenant (WITH CHECK)', async () => {
    await assert.rejects(
      withTenant(pool, A, (c) => c.query(`INSERT INTO documents (tenant_id, title) VALUES ('${B}', 'sneaky')`)),
      (e: any) => e.code === '42501',
    );
  });

  it('cannot move a row to another tenant', async () => {
    await assert.rejects(
      withTenant(pool, A, (c) => c.query(`UPDATE documents SET tenant_id = '${B}'`)),
      (e: any) => e.code === '42501',
    );
  });

  it("cannot attach a child row to another tenant's parent (composite FK)", async () => {
    await assert.rejects(
      withTenant(pool, A, (c) =>
        c.query(`INSERT INTO chunks (document_id, content, embedding) VALUES ($1, 'x', $2)`, [docB, toVectorLiteral(fakeEmbedding(9))]),
      ),
      (e: any) => e.code === '23503',
    );
  });

  it('cannot read or update another tenant by id', async () => {
    const n = await withTenant(pool, A, async (c) => (await c.query(`UPDATE documents SET title = 'pwned' WHERE id = $1`, [docB])).rowCount);
    assert.equal(n, 0);
  });

  it('hybrid search fuses vector and keyword ranks, accent-insensitively', async () => {
    const hits = await withTenant(pool, A, (c) =>
      hybridSearch(c, { embedding: fakeEmbedding(2), query: 'thanh toan vnpay', limit: 5 }),
    );
    assert.ok(hits.length >= 2);
    const payment = hits.find((h) => h.content.startsWith('Hướng dẫn thanh toán'))!;
    const refund = hits.find((h) => h.content.startsWith('Chính sách đổi trả'))!;
    assert.equal(payment.keyword_rank, 1, 'unaccented query should match accented text');
    assert.equal(refund.semantic_rank, 1, 'closest embedding should rank first semantically');
    assert.ok(hits.every((h) => h.document_id === docA), 'only tenant A documents');
  });

  it('a question still gets keyword matches: when no chunk has every word, any-word matches take over', async () => {
    const hits = await withTenant(pool, A, (c) => hybridSearch(c, { embedding: fakeEmbedding(42), query: 'làm sao để thanh toán qua vnpay?', limit: 5 }));
    const payment = hits.find((h) => h.content.startsWith('Hướng dẫn thanh toán'))!;
    assert.equal(payment.keyword_rank, 1, '"làm sao để" appears in no chunk, so an AND-only keyword search found nothing');
  });

  it("hybrid search never returns another tenant's identical content", async () => {
    const hits = await withTenant(pool, B, (c) => hybridSearch(c, { embedding: fakeEmbedding(1), query: 'thanh toán' }));
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.document_id === docB));
  });

  it('RLS audit passes, and flags a new tenant table without RLS', async () => {
    let audit = await auditRows();
    assert.deepEqual(audit.leaks, []);
    assert.deepEqual(audit.bypass, []);
    assert.deepEqual(audit.unfiltered, [], 'every policy of the kit schema filters by tenant');
    await admin.query(`CREATE TABLE invoices (id serial PRIMARY KEY, tenant_id uuid NOT NULL)`);
    audit = await auditRows();
    assert.deepEqual(audit.leaks.map((r) => r.table_name), ['invoices']);
    await admin.query(`DROP TABLE invoices`);
  });
});
