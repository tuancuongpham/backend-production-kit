import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// @ts-ignore — plain JS module
import { fillTemplate, slugify } from '../../../skills/adr-writer/scripts/new-adr.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../skills/adr-writer/scripts/new-adr.mjs', import.meta.url));

describe('adr-writer', () => {
  it('fills the template with the title exactly as typed', () => {
    const title = "Giá theo bậc $& và $' — xem {{DATE}}";
    assert.equal(fillTemplate('# ADR-{{NUMBER}}: {{TITLE}} ({{DATE}})', { NUMBER: '0007', TITLE: title, DATE: '2026-10-22' }), `# ADR-0007: ${title} (2026-10-22)`);
  });

  it('slugifies Vietnamese titles', () => {
    assert.equal(slugify('Dùng RLS để cách ly dữ liệu đa khách hàng'), 'dung-rls-de-cach-ly-du-lieu-da-khach-hang');
    assert.equal(slugify('  Fail-open vs. fail-closed!  '), 'fail-open-vs-fail-closed');
  });

  it('numbers ADRs, fills the template, maintains the index and supersession links', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'adr-'));
    await run(process.execPath, [script, 'Use Postgres RLS for tenant isolation'], { cwd });
    await run(process.execPath, [script, 'Rate limiter fails closed on LLM routes', '--status', 'Accepted'], { cwd });
    await run(process.execPath, [script, 'Chuyển sang ParadeDB BM25', '--supersedes', '1'], { cwd });

    const dir = path.join(cwd, 'docs', 'adr');
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, [
      '0001-use-postgres-rls-for-tenant-isolation.md',
      '0002-rate-limiter-fails-closed-on-llm-routes.md',
      '0003-chuyen-sang-paradedb-bm25.md',
      'README.md',
    ]);

    const second = await readFile(path.join(dir, files[1]), 'utf8');
    assert.match(second, /^# ADR-0002: Rate limiter fails closed on LLM routes$/m);
    assert.match(second, /^- \*\*Status:\*\* Accepted$/m);
    assert.match(second, /^- \*\*Date:\*\* \d{4}-\d{2}-\d{2}$/m);
    assert.ok(!second.includes('{{'), 'no unfilled placeholders');

    const first = await readFile(path.join(dir, files[0]), 'utf8');
    assert.match(first, /Superseded by \[ADR-0003\]\(0003-chuyen-sang-paradedb-bm25\.md\)/);
    const third = await readFile(path.join(dir, files[2]), 'utf8');
    assert.match(third, /Supersedes \[ADR-0001\]/);

    const index = await readFile(path.join(dir, 'README.md'), 'utf8');
    assert.match(index, /\| \[0002\]\(0002-rate-limiter-fails-closed-on-llm-routes\.md\) \| Rate limiter fails closed on LLM routes \| Accepted \|/);
    assert.match(index, /\| \[0001\].*\| Superseded by/);
  });
});
