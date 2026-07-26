// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // ─── Strict TypeScript — no any, ever ─────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',          // ❌ no "any" type
      '@typescript-eslint/no-unsafe-argument': 'error',       // ❌ no passing any-typed args
      '@typescript-eslint/no-unsafe-assignment': 'error',     // ❌ no assigning any to variables
      '@typescript-eslint/no-unsafe-call': 'error',           // ❌ no calling any-typed functions
      '@typescript-eslint/no-unsafe-member-access': 'error',  // ❌ no accessing props on any
      '@typescript-eslint/no-unsafe-return': 'error',         // ❌ no returning any

      // ─── Code Quality ─────────────────────────────────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',     // ❌ always await or handle promises
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], // ❌ no unused vars (prefix with _ to ignore)

      // ─── Formatting ───────────────────────────────────────────────────────
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
