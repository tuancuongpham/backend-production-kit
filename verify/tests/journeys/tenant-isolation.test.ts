// Journey: two shops on one platform, each with its own help center. What their users, and someone probing, do over
// HTTP: search, open documents, edit an id in the URL, send no tenant or a garbage one, put %00 or an odd limit in
// the query string, and hit the API from both shops at once over a small connection pool. Rows are scoped inside
// Postgres (Row-Level Security), as an app role that is not a superuser: the handlers never filter by tenant.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDatabase, runSqlFile, withUser } from '../support/infra.ts';
import { fakeEmbedding, toVectorLiteral } from '../support/vectors.ts';
import { request, sendJson } from '../support/http.ts';
import { createHardenedServer } from '../../../skills/service-hardening/references/server.ts';
import { hybridSearch, withTenant } from '../../../skills/multitenant-postgres/references/tenant-db.ts';

const SHOP_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SHOP_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pool: pg.Pool; // as app_user, through RLS
let app: { port: number; shutdown(): Promise<unknown> };
const docsOf: Record<string, string[]> = { [SHOP_A]: [], [SHOP_B]: [] };

async function addDocument(shop: string, title: string, chunks: string[]): Promise<string> {
  return withTenant(pool, shop, async (c) => {
    const id = (await c.query(`INSERT INTO documents (title) VALUES ($1) RETURNING id`, [title])).rows[0].id as string;
    for (const [i, content] of chunks.entries()) {
      await c.query(`INSERT INTO chunks (document_id, ordinal, content, embedding) VALUES ($1, $2, $3, $4)`, [id, i, content, toVectorLiteral(fakeEmbedding(i + 1))]);
    }
    docsOf[shop].push(id);
    return id;
  });
}

async function startApp() {
  const server = createHardenedServer({
    drainDelayMs: 0,
    handler: async (req, res) => {
      const shop = req.headers['x-shop-id']; // from the authenticated session
      if (typeof shop !== 'string' || !UUID.test(shop)) return sendJson(res, 401, { error: 'unauthenticated' });
      const url = new URL(req.url ?? '/', 'http://help');
      try {
        if (url.pathname === '/v1/help/search') {
          const q = url.searchParams.get('q') ?? '';
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
          const hits = await withTenant(pool, shop, (c) => hybridSearch(c, { embedding: fakeEmbedding(1), query: q, limit }));
          return sendJson(res, 200, { hits: hits.map((h) => ({ documentId: h.document_id, content: h.content })) });
        }
        const doc = /^\/v1\/help\/documents\/([^/]+)$/.exec(url.pathname);
        if (doc) {
          // Not a uuid: no such document. The same answer as for another shop's document, which RLS hides.
          if (!UUID.test(doc[1])) return sendJson(res, 404, { error: 'not_found' });
          const row = await withTenant(pool, shop, async (c) => (await c.query(`SELECT id, title FROM documents WHERE id = $1`, [doc[1]])).rows[0]);
          return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: 'not_found' });
        }
        sendJson(res, 404, { error: 'not_found' });
      } catch (err) {
        if (err instanceof RangeError) return sendJson(res, 400, { error: err.message }); // a limit the search refused
        throw err;
      }
    },
  });
  return { port: await server.listen(0, '127.0.0.1'), shutdown: server.shutdown };
}

const as = (shop: string | undefined, path: string) => request(app.port, { path, headers: shop === undefined ? {} : { 'x-shop-id': shop } });
const search = (shop: string, q: string, extra = '') => as(shop, `/v1/help/search?q=${encodeURIComponent(q)}${extra}`);

describe('journey: two shops share the platform, never their data', () => {
  before(async () => {
    const dbUrl = await freshDatabase('kit_journey_tenants');
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    await runSqlFile(admin, 'multitenant-postgres', 'schema.sql');
    await admin.query(`ALTER ROLE app_user PASSWORD 'app-test-pw'`);
    await admin.query(`INSERT INTO tenants (id, name) VALUES ($1, 'Shop Lan'), ($2, 'Shop Minh')`, [SHOP_A, SHOP_B]);
    await admin.end();
    pool = new pg.Pool({ connectionString: withUser(dbUrl, 'app_user', 'app-test-pw'), max: 2 }); // small on purpose
    await addDocument(SHOP_A, 'Thanh toán', ['Hướng dẫn thanh toán qua VNPay và MoMo', 'Chính sách đổi trả trong 30 ngày']);
    await addDocument(SHOP_B, 'Thanh toán', ['Hướng dẫn thanh toán qua VNPay và MoMo']); // the same words, another shop
    await addDocument(SHOP_B, 'Nội bộ', ['Lộ trình sản phẩm quý sau của Shop Minh']);
    app = await startApp();
  });
  after(async () => {
    await app?.shutdown();
    await pool?.end();
  });

  it('each shop searches its own help center: the same words in the other shop never show up', async () => {
    for (const shop of [SHOP_A, SHOP_B]) {
      const { hits } = (await search(shop, 'thanh toán VNPay')).json();
      assert.ok(hits.length > 0);
      assert.ok(hits.every((h: { documentId: string }) => docsOf[shop].includes(h.documentId)), shop);
    }
    const { hits } = (await search(SHOP_A, 'lộ trình sản phẩm')).json();
    assert.ok(hits.every((h: { content: string }) => !h.content.includes('Shop Minh')));
  });

  it("a user edits the document id in the URL to another shop's document: 404, the same as for one that doesn't exist", async () => {
    const theirs = docsOf[SHOP_B][1];
    assert.equal((await as(SHOP_A, `/v1/help/documents/${theirs}`)).status, 404);
    assert.equal((await as(SHOP_B, `/v1/help/documents/${theirs}`)).status, 200);
    for (const edited of ['00000000-0000-4000-8000-000000000000', 'abc', encodeURIComponent("' OR 1=1 --")]) {
      assert.equal((await as(SHOP_A, `/v1/help/documents/${edited}`)).status, 404, edited);
    }
  });

  it('a request without a shop, or with a garbage one, is refused before any query', async () => {
    for (const shop of [undefined, '', 'shop-a', `${SHOP_A}' OR '1'='1`]) {
      assert.equal((await as(shop, '/v1/help/search?q=VNPay')).status, 401, String(shop));
    }
  });

  it('what people type into a search box is searched, not a database error: Vietnamese, emoji, %00, nothing at all', async () => {
    for (const q of ['làm sao để hủy đơn?', 'đổi trả 🙏', 'VNPay\u0000MoMo', '', ' ']) {
      assert.equal((await search(SHOP_A, q)).status, 200, JSON.stringify(q));
    }
  });

  it('a limit from the query string the search refuses is a 400 with the reason; a sane one is honoured', async () => {
    for (const limit of ['-1', '1.5', 'abc', '', '1000000']) {
      const reply = await search(SHOP_A, 'VNPay', `&limit=${limit}`);
      assert.deepEqual([reply.status, /limit must be an integer/.test(reply.json().error)], [400, true], limit);
    }
    assert.ok((await search(SHOP_A, 'thanh toán', '&limit=1')).json().hits.length <= 1);
  });

  it('both shops at once over a pool of two connections: 60 interleaved requests, each answered from its own shop', async () => {
    const shops = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? SHOP_A : SHOP_B));
    const answers = await Promise.all(shops.map((shop) => search(shop, 'thanh toán VNPay').then((r) => ({ shop, hits: r.json().hits }))));
    for (const { shop, hits } of answers) {
      assert.ok(hits.every((h: { documentId: string }) => docsOf[shop].includes(h.documentId)), 'a connection reused across shops leaked');
    }
  });

  it("a document one shop adds is in its search at once, and never in the other's", async () => {
    const added = await addDocument(SHOP_A, 'Giao hàng', ['Giao hàng nhanh trong 2 giờ ở Hà Nội']);
    assert.ok((await search(SHOP_A, 'giao hàng nhanh')).json().hits.some((h: { documentId: string }) => h.documentId === added));
    assert.ok(!(await search(SHOP_B, 'giao hàng nhanh')).json().hits.some((h: { documentId: string }) => h.documentId === added));
  });
});
