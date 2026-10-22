#!/usr/bin/env node
// Every test, with code coverage of the reference code and the shared kernel, failing below the thresholds CI
// enforces. A skill's copy of a kernel file is identical to shared/ (`npm run validate` checks it), so the kernel is
// measured once, in shared/, by its own tests in verify/tests/kernel: the copies are left out, or each would count
// again with only the paths its skill happens to use.
import { spawnSync } from 'node:child_process';
import { sharedFiles } from './lib/kernel.mjs';

const THRESHOLDS = { lines: 98, branches: 90, functions: 95 };

const args = [
  '--test',
  '--test-concurrency=1',
  '--experimental-test-coverage',
  '--test-coverage-include=skills/*/references/*.ts',
  '--test-coverage-include=shared/*.ts',
  ...sharedFiles().map((file) => `--test-coverage-exclude=skills/*/references/${file}`),
  ...Object.entries(THRESHOLDS).map(([kind, min]) => `--test-coverage-${kind}=${min}`),
  ...(process.argv.length > 2 ? process.argv.slice(2) : ['verify/tests/**/*.test.ts']),
];
const { status } = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(status ?? 1);
