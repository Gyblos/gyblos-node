import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      '.local/**',
      'tests/**',
      'evidence/**',
      'dist/**',
      'coverage/**',
    ],
  },
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': [
        'warn',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      '@typescript-eslint/no-magic-numbers': [
        'warn',
        {
          ignore: [0, 1, -1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          enforceConst: true,
        },
      ],
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
];
