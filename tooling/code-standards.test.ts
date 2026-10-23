// Checks the repo's standards and version-metadata lints; it must never initialize product applications.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { ESLint, Linter } from 'eslint';

import standards from './code-standards.js';

const eslint = new ESLint();
// Snippets are linted as a virtual file that is not on disk. Reusing a real
// source path lets the typed program mix the on-disk file with the snippet.
const fixture = 'packages/core/src/standards-fixture.ts';
const snippetLint = new ESLint({
  overrideConfig: {
    files: [fixture],
    languageOptions: {
      parserOptions: {
        project: null,
        projectService: { allowDefaultProject: [fixture] },
        tsconfigRootDir: resolve('.'),
      },
    },
  },
});
const filePath = resolve(fixture);
async function rules(code: string) {
  const [result] = await snippetLint.lintText(code, { filePath });
  return result!.messages.map((message) => message.ruleId);
}

void test('standards lint rejects layout, opaque names and nonlocal relative imports', async () => {
  for (const path of [
    'evidence/synthetic-private.mjs',
    'lab/evidence/synthetic-private.mjs',
  ])
    assert.equal(await eslint.isPathIgnored(resolve(path)), true);
  assert.deepEqual(
    await rules('export function run() {}\ninterface Later {}'),
    [],
  );
  assert.deepEqual(await rules('const hidden = 1;'), []);
  assert.ok(
    (await rules('const value = { limit: 1 } as { limit: number };')).includes(
      '@typescript-eslint/consistent-type-assertions',
    ),
  );
  assert.ok(
    (
      await rules(
        'export function longStep() {\n' + 'void 0;\n'.repeat(81) + '}',
      )
    ).includes('max-lines-per-function'),
  );
  assert.ok((await rules('// line\n'.repeat(401))).includes('max-lines'));
  assert.ok(
    (await rules('const first = 1, second = 2;')).includes(
      'no-restricted-syntax',
    ),
  );
  assert.deepEqual(
    await rules(
      'export function run(i: number, tx: number) { return i + tx; }',
    ),
    [],
  );
  assert.ok(
    (await rules('Promise.resolve();')).includes(
      '@typescript-eslint/no-floating-promises',
    ),
  );
  assert.ok(
    (await rules('export function run(c: string) { return c; }')).includes(
      'gyblos/structure',
    ),
  );
  assert.ok(
    (
      await rules("import { value } from '../../config/src/index.js';")
    ).includes('gyblos/package-boundaries'),
  );
  assert.ok(
    (
      await rules("export { value } from '../../config/src/index.js';")
    ).includes('gyblos/package-boundaries'),
  );
  assert.ok(
    (await rules("import { run } from '../../../scripts/run.js';")).includes(
      'gyblos/package-boundaries',
    ),
  );
  for (const dynamic of [
    "export async function load() { return import('../../config/src/index.js'); }",
    'export async function load() { return import(`../../config/src/index.js`); }',
  ])
    assert.ok((await rules(dynamic)).includes('gyblos/package-boundaries'));
  assert.deepEqual(
    await rules(
      "export async function load() { return import('./local.js'); }",
    ),
    [],
  );
});

void test('standards lint detects numeric values inside object literals', async () => {
  assert.ok(
    (await rules('export function timeout() { return 7000; }')).includes(
      'no-magic-numbers',
    ),
  );
  assert.deepEqual(
    await rules(
      'const ZERO = 0n;\ninterface Input { value: number }\nfunction prepare(input: Input) { return input.value; }\nexport function run(input: Input) { return prepare(input) + 1; }',
    ),
    [],
  );
});

void test('version metadata pins match installed-source manifests', async () => {
  const results = await eslint.lintFiles(['packages/config/src/versions.ts']);
  assert.equal(
    results.reduce((sum, result) => sum + result.errorCount, 0),
    0,
  );
});

void test('version metadata lint rejects a dependency pin mismatch', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-version-rule-'));
  try {
    await mkdir(join(directory, 'packages/config/src'), { recursive: true });
    await mkdir(join(directory, 'apps'));
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ dependencies: { '@x402/core': '2.28.0' } }),
    );
    await writeFile(
      join(directory, 'packages/config/package.json'),
      JSON.stringify({ dependencies: { '@x402/core': '0.0.0' } }),
    );
    const linter = new Linter({ cwd: directory });
    const configuration: Linter.Config[] = [
      {
        files: ['**/*.ts'],
        plugins: {
          gyblos: standards as unknown as NonNullable<
            Linter.Config['plugins']
          >[string],
        },
        rules: { 'gyblos/version-pins': 'error' },
      },
    ];
    const filename = join(directory, 'packages/config/src/versions.ts');
    const inspect = () =>
      linter.verify('export const VERSION = "fixture";', configuration, {
        filename,
      });
    const messages = inspect();
    assert.ok(
      messages.some((message) => message.ruleId === 'gyblos/version-pins'),
    );
    await writeFile(
      join(directory, 'packages/config/package.json'),
      JSON.stringify({ dependencies: { '@x402/core': '2.28.0' } }),
    );
    // A generated-only leftover directory is not a workspace manifest.
    await mkdir(join(directory, 'packages/old-package/node_modules'), {
      recursive: true,
    });
    assert.deepEqual(inspect(), []);
    await mkdir(join(directory, 'lab/harness'), { recursive: true });
    await writeFile(
      join(directory, 'lab/harness/package.json'),
      JSON.stringify({ dependencies: { '@x402/core': '0.0.0' } }),
    );
    assert.ok(
      inspect().some((message) => message.ruleId === 'gyblos/version-pins'),
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
