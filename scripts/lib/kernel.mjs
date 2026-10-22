// Which files of the shared kernel (shared/*.ts) a skill needs: the ones its own reference code imports, and the
// ones those import in turn (worker-loop.ts imports hooks.ts). Used by sync-shared.mjs, which copies them, and by
// validate-skills.mjs, which checks the copies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The kernel's file names. */
export function sharedFiles() {
  return existsSync('shared') ? readdirSync('shared').filter((f) => f.endsWith('.ts')) : [];
}

const importsOf = (source, files) => files.filter((f) => source.includes(`'./${f}'`));

/** The kernel files the skill whose reference code is in `referencesDir` needs, directly or through another one. */
export function kernelFilesFor(referencesDir, files = sharedFiles()) {
  const own = readdirSync(referencesDir)
    .filter((f) => f.endsWith('.ts') && !files.includes(f))
    .map((f) => readFileSync(path.join(referencesDir, f), 'utf8'));
  const needed = new Set(own.flatMap((source) => importsOf(source, files)));
  // A Set's iteration also visits what is added during it: this runs until nothing new is imported.
  for (const file of needed) for (const dep of importsOf(readFileSync(path.join('shared', file), 'utf8'), files)) needed.add(dep);
  return needed;
}
