// Checks the repo's standards and version-metadata lints, and that typed journals keep JSON
// serialization and terminal-state guards.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { ESLint, Linter } from 'eslint';

import { RECONCILIATION_CLASSIFICATIONS } from '@gyblos/lab-harness/constants';
import {
  assertNoUnresolvedAuthorizations,
  saveJournal,
} from '@gyblos/lab-harness/journal';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';

import standards from '../tooling/code-standards.js';

const eslint = new ESLint();
const filePath = resolve('packages/core/src/gate.ts');
async function rules(code: string) {
  const [result] = await eslint.lintText(code, { filePath });
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

void test('typed journals preserve JSON serialization and path-specific terminal guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-typed-journals-'));
  try {
    const path = join(directory, 'exact-attempt.json');
    const record = {
      state: JOURNAL_STATES.CONFIRMED,
      transaction: 'public-signature',
      authorizationHash: 'public-hash',
      buyerSignature: 'public-buyer-signature',
      blockhash: undefined,
    };
    await saveJournal(path, record);
    assert.deepEqual(
      JSON.parse(await readFile(path, 'utf8')),
      JSON.parse(JSON.stringify(record)),
    );
    await assertNoUnresolvedAuthorizations([path] as Parameters<
      typeof assertNoUnresolvedAuthorizations
    >[0]);
    await saveJournal(path, {
      ...record,
      state: JOURNAL_STATES.UNCERTAIN,
      buyer: 'buyer',
      reconciliation: {
        classification: RECONCILIATION_CLASSIFICATIONS.UNAVAILABLE,
      },
    });
    await assert.rejects(
      assertNoUnresolvedAuthorizations([path] as Parameters<
        typeof assertNoUnresolvedAuthorizations
      >[0]),
      /Reconcile/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
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
