// Lint rules that catch bugs, not style. Each one below is a bug class this kit has had or that its patterns invite:
// a promise nobody awaits (an unhandled rejection ends the process), a `return` inside `try` that skips its `catch`,
// a switch that forgets a case, a thrown string with no stack. Formatting is left to the formatter.
// Type-aware: the rules read the TypeScript types through tsconfig.json.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', '**/*-workspace/', 'bench/results/', 'skills/llm-observability/references/otel-setup.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: { allowDefaultProject: ['*.mjs', 'scripts/*.mjs', 'skills/adr-writer/scripts/*.mjs'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Promises: the bug class that crashes Node processes.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test's describe/it return promises the runner itself awaits.
          allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }],
        },
      ],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      // Exhaustiveness: a new outcome or tier that one switch forgets.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      // Correctness.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Database rows and provider payloads are `any` at the boundary on purpose; the code narrows them where it matters.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Plain JavaScript scripts: the type-aware rules need types they don't have.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
