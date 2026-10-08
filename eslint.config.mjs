// ESLint flat config for the backend.
// Rules that catch real bugs are errors; style debt that exists across the
// codebase today (explicit `any`, unused vars) is a warning so CI can run
// clean now and the warnings can be paid down over time.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'yolo-service/**', 'coverage/**', 'examples/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Real bugs: keep as errors.
      'no-async-promise-executor': 'error',
      '@typescript-eslint/no-floating-promises': 'off', // needs type-aware linting; enabled later
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  }
);
