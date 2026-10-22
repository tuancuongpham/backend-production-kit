#!/usr/bin/env node
// Copies each building block in shared/ into every skill whose reference code needs it (imports it, or imports a
// kernel file that does), and removes copies no skill needs any more. Skills ship as separate .skill files, so a
// skill can't import another skill's files: the shared kernel is vendored, and `npm run validate` fails if a copy
// drifts from shared/.
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { kernelFilesFor, sharedFiles } from './lib/kernel.mjs';

const shared = sharedFiles();
const changes = [];
for (const skill of readdirSync('skills')) {
  const dir = path.join('skills', skill, 'references');
  if (!existsSync(dir)) continue;
  const needed = kernelFilesFor(dir, shared);
  for (const file of shared) {
    const target = path.join(dir, file);
    if (needed.has(file)) {
      const canonical = readFileSync(path.join('shared', file));
      if (!existsSync(target) || !readFileSync(target).equals(canonical)) {
        copyFileSync(path.join('shared', file), target);
        changes.push(`copied  ${target}`);
      }
    } else if (existsSync(target)) {
      rmSync(target);
      changes.push(`removed ${target}`);
    }
  }
}
console.log(changes.length ? changes.join('\n') : 'shared building blocks are in sync');
