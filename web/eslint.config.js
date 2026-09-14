import js from '@eslint/js'
import ts from 'typescript-eslint'
import hooks from 'eslint-plugin-react-hooks'

export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', 'test/golden/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      // the simulation deliberately uses non-null assertions on data it has just parsed
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
      }],
      // typed-array plumbing and the packed format genuinely need `any` in places
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // The measurement harnesses are Node scripts that also carry page.evaluate bodies,
    // so their source legitimately names both Node and browser globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        window: 'readonly', document: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly', devicePixelRatio: 'readonly',
        Promise: 'readonly', Uint8Array: 'readonly', Uint16Array: 'readonly',
      },
    },
  },
)
