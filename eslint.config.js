import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.orca/**', '.tsbuild/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Copied from agent-office (see NOTICE). Terminal escape handling matches control characters
    // on purpose, and the store and registries grow by declaration merging into empty interfaces.
    files: ['client/src/**', 'client/test/**', 'shared/src/office/**'],
    rules: {
      'no-control-regex': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-useless-assignment': 'off',
    },
  },
);
