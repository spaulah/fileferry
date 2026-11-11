// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'package-lock.json']
  },
  eslint.configs.recommended,
  // Type-aware rules, so the checks use the same project settings as the compiler.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: [
          './packages/core/tsconfig.test.json',
          './packages/fake-graph/tsconfig.json',
          './apps/demo/tsconfig.json'
        ],
        tsconfigRootDir: import.meta.dirname
      },
      globals: { ...globals.node, ...globals.browser }
    }
  },
  {
    files: ['apps/demo/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  },
  {
    files: ['**/*.test.ts', '**/vitest.config.ts'],
    rules: {
      // Test fixtures are often stubs: async signatures without awaits, and direct
      // indexing where a failure should be obvious. The library code keeps the full rules.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off'
    }
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // `||` on strings is intentional where an empty string should fall through.
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      // Numbers in log and error messages are routine.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  },
  {
    // Plain JavaScript config files are not part of any TypeScript project.
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked]
  }
);
