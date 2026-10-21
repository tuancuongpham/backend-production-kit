#!/usr/bin/env node
// Print the CHANGELOG section for one version (used as GitHub release notes).
//   node scripts/release-notes.mjs 0.2.0
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: release-notes.mjs <version>');
  process.exit(2);
}
const lines = readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
console.log(lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim());
