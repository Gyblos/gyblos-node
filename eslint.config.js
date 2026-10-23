// Owns static style checks; it must never initialize product applications.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import tseslint from 'typescript-eslint';

import standards from './tooling/code-standards.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

export default [
  {
    ignores: [
      '**/node_modules/**',
      '.local/**',
      'evidence/**',
      'lab/evidence/**',
      '**/dist/**',
      'coverage/**',
    ],
  },
  {
    files: [
      'apps/**/*.ts',
      'packages/**/*.ts',
      'lab/**/*.ts',
      'tests/**/*.ts',
      'tooling/**/*.ts',
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.tests.json'],
        tsconfigRootDir: ROOT,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, gyblos: standards },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'as',
          objectLiteralTypeAssertions: 'never',
          arrayLiteralTypeAssertions: 'allow',
        },
      ],
      'max-lines': ['warn', { max: 400 }],
      'max-lines-per-function': [
        'warn',
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclaration[declarations.length>1]',
          message: 'Use one declaration per const or let.',
        },
      ],
      'no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1, 2, '-1n', '0n', '1n', '2n'],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          detectObjects: false,
          enforceConst: true,
        },
      ],
    },
  },
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'lab/**/*.ts'],
    rules: {
      'gyblos/package-boundaries': 'error',
      'gyblos/structure': 'warn',
    },
  },
  // Numeric definitions and independent expected fixtures are the canonical source.
  {
    files: [
      'packages/config/**/*.ts',
      '**/constants.ts',
      'tests/**/*.ts',
      '**/*.test.ts',
    ],
    rules: { 'no-magic-numbers': 'off' },
  },
  // Test cases and lab scripts may be long; product and tooling keep the function-length warning.
  {
    files: ['tests/**/*.ts', 'lab/**/*.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
  // Invalid boundary inputs and deliberately partial SDK doubles are test data.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow' },
      ],
    },
  },
  {
    files: ['packages/config/src/versions.ts'],
    rules: { 'gyblos/version-pins': 'error' },
  },
];
