#!/usr/bin/env node
// Static checks for the kit: SKILL.md frontmatter (the rules claude.ai / skill-creator enforce on upload),
// relative links in every markdown file, and eval sets. Exits 1 with a list of problems.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const errors = [];
const fail = (msg) => errors.push(msg);
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);
const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const walk = (dir) =>
  readdirSync(dir, { recursive: true })
    .map((p) => path.join(dir, String(p)))
    .filter((p) => !p.includes('node_modules') && statSync(p).isFile());

const skills = readdirSync('skills').filter((d) => statSync(path.join('skills', d)).isDirectory());

// 1. SKILL.md frontmatter and size.
for (const name of skills) {
  const dir = path.join('skills', name);
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file)) {
    fail(`${dir}: missing SKILL.md`);
    continue;
  }
  const nested = walk(dir).filter((p) => path.basename(p) === 'SKILL.md');
  if (nested.length !== 1) fail(`${dir}: expected exactly one SKILL.md, found ${nested.length}`);

  const text = read(file);
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    fail(`${file}: no YAML frontmatter`);
    continue;
  }
  const fm = {};
  for (const line of fmMatch[1].split('\n').filter((l) => l.trim())) {
    const i = line.indexOf(':');
    if (i < 0) {
      fail(`${file}: frontmatter line without a key: ${line}`);
      continue;
    }
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of Object.keys(fm)) if (!ALLOWED_KEYS.has(key)) fail(`${file}: unexpected frontmatter key "${key}"`);
  if (fm.name !== name) fail(`${file}: name "${fm.name}" must equal the folder name "${name}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name ?? '') || (fm.name ?? '').length > 64) fail(`${file}: name must be kebab-case, ≤ 64 chars`);
  const desc = fm.description ?? '';
  if (!desc) fail(`${file}: missing description`);
  if (desc.length > 1024) fail(`${file}: description is ${desc.length} chars (max 1024)`);
  if (/[<>]/.test(desc)) fail(`${file}: description must not contain < or >`);
  // Plain YAML scalars break on ": " and " #"; quote the value if you need them.
  if (!/^["']/.test(desc) && (/: /.test(desc) || / #/.test(desc))) fail(`${file}: unquoted description contains ": " or " #"`);
  const lines = text.split('\n').length;
  if (lines > 500) fail(`${file}: ${lines} lines (keep SKILL.md under 500; move detail to references/)`);
}

// 2. Relative links in markdown resolve to real files.
const markdown = [
  'README.md',
  'CHANGELOG.md',
  ...walk('skills'),
  ...walk('docs'),
  ...walk('.github'),
  // assets/ hold fill-in templates whose links are placeholders by design
].filter((f) => f.endsWith('.md') && !f.split(path.sep).includes('assets'));
for (const file of markdown) {
  const text = read(file).replace(/```[\s\S]*?```/g, ''); // ignore code blocks
  for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = path.resolve(path.dirname(file), href.split('#')[0]);
    if (!existsSync(target)) fail(`${file}: broken link → ${href}`);
  }
}

// 3. Eval sets parse and point at real skills; they must stay outside skills/ (agents must not read them).
if (existsSync('evals')) {
  for (const name of readdirSync('evals')) {
    const file = path.join('evals', name, 'evals.json');
    if (!existsSync(file)) continue;
    try {
      const ev = JSON.parse(read(file));
      if (ev.skill_name !== name) fail(`${file}: skill_name "${ev.skill_name}" ≠ folder "${name}"`);
      if (!skills.includes(name)) fail(`${file}: no skill named "${name}"`);
      for (const e of ev.evals ?? []) if (!e.prompt) fail(`${file}: eval ${e.id} has no prompt`);
    } catch (e) {
      fail(`${file}: ${e.message}`);
    }
  }
}
for (const name of skills) {
  if (existsSync(path.join('skills', name, 'evals'))) fail(`skills/${name}/evals: eval sets belong in evals/${name}/ (agents read skill folders)`);
}

// 4. The shared kernel (shared/*.ts) is vendored into the skills that import it: every copy must be identical,
//    every import must have its copy, and no copy may linger unused. `npm run sync:shared` fixes all three.
const sharedFiles = existsSync('shared') ? readdirSync('shared').filter((f) => f.endsWith('.ts')) : [];
for (const name of skills) {
  const dir = path.join('skills', name, 'references');
  if (!existsSync(dir)) continue;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !sharedFiles.includes(f)).map((f) => read(path.join(dir, f)));
  for (const file of sharedFiles) {
    const copy = path.join(dir, file);
    const imported = sources.some((s) => s.includes(`'./${file}'`));
    if (imported && !existsSync(copy)) fail(`${copy}: imported but missing (run npm run sync:shared)`);
    else if (imported && read(copy) !== read(path.join('shared', file))) fail(`${copy}: differs from shared/${file} (edit shared/, then npm run sync:shared)`);
    else if (!imported && existsSync(copy)) fail(`${copy}: no longer imported (run npm run sync:shared)`);
  }
}

if (errors.length) {
  console.error(`✖ ${errors.length} problem(s):\n` + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✔ ${skills.length} skills, ${markdown.length} markdown files and eval sets are valid`);
