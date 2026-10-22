import tseslint from 'typescript-eslint';

import standards from './tooling/code-standards.js';

export default [
  {
    ignores: [
      'node_modules/**',
      '.local/**',
      'evidence/**',
      'dist/**',
      'coverage/**',
    ],
  },
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin, gyblos: standards },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['error', { max: 300 }],
      'gyblos/structure': 'error',
      'gyblos/numeric-constants': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'tooling/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['error', { max: 300 }],
    },
  },
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '../../*/packages/*',
            '**/scripts/*',
            '../../../packages/**',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/config/**/*.ts', '**/constants.ts'],
    rules: { 'gyblos/numeric-constants': 'off' },
  },
  {
    files: ['packages/config/src/versions.ts'],
    rules: { 'gyblos/version-pins': 'error' },
  },
];
