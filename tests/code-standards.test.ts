import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { ESLint, Linter } from 'eslint';

import {
  assertNoUnresolvedAuthorizations,
  saveJournal,
} from '@gyblos/gate/journal';

import standards from '../tooling/code-standards.js';

const eslint = new ESLint();
const filePath = resolve('packages/application/src/lint-sample.ts');
async function rules(code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((message) => message.ruleId);
}

test('standards lint rejects layout, opaque names and nonlocal relative imports', async () => {
  assert.ok(
    (await rules('export function run() {}\ninterface Later {}')).includes(
      'gyblos/structure',
    ),
  );
  assert.ok((await rules('const hidden = 1;')).includes('gyblos/structure'));
  assert.ok(
    (await rules('export function run(c: string) { return c; }')).includes(
      'gyblos/structure',
    ),
  );
  assert.ok(
    (
      await rules("import { value } from '../../config/src/index.js';")
    ).includes('gyblos/structure'),
  );
  assert.ok(
    (
      await rules("export { value } from '../../config/src/index.js';")
    ).includes('gyblos/structure'),
  );
  assert.ok(
    (await rules("import { run } from '../../../scripts/run.js';")).includes(
      'gyblos/structure',
    ),
  );
});

test('standards lint detects numeric values inside object literals', async () => {
  assert.ok(
    (await rules('export const settings = { timeout: 7000 };')).includes(
      'gyblos/numeric-constants',
    ),
  );
  assert.deepEqual(
    await rules(
      'const ZERO = 0n;\ninterface Input { value: number }\nfunction prepare(input: Input) { return input.value; }\nexport function run(input: Input) { return prepare(input) + 1; }',
    ),
    [],
  );
});

test('version metadata pins match installed-source manifests', async () => {
  const results = await eslint.lintFiles(['packages/config/src/versions.ts']);
  assert.equal(
    results.reduce((sum, result) => sum + result.errorCount, 0),
    0,
  );
});

test('typed journals preserve JSON serialization and path-specific terminal guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-typed-journals-'));
  try {
    const path = join(directory, 'exact-attempt.json');
    const record = {
      state: 'confirmed' as const,
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
      state: 'uncertain',
      buyer: 'buyer',
      reconciliation: { classification: 'reconciliation-unavailable' },
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

test('version metadata lint rejects a dependency pin mismatch', async () => {
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
    const messages = new Linter({ cwd: directory }).verify(
      'export const VERSION = "fixture";',
      [
        {
          files: ['**/*.ts'],
          plugins: {
            gyblos: standards as unknown as NonNullable<
              Linter.Config['plugins']
            >[string],
          },
          rules: { 'gyblos/version-pins': 'error' },
        },
      ],
      { filename: join(directory, 'packages/config/src/versions.ts') },
    );
    assert.ok(
      messages.some((message) => message.ruleId === 'gyblos/version-pins'),
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
