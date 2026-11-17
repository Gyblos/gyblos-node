// Checks buyer dependency ownership and isolated package resolution without starting the buyer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import ts from 'typescript';

const BUYER = resolve('apps/buyer');
const ADAPTER_ENTRY = '@gyblos/payments-upto/batch-session';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function buyerManifest(): Promise<Record<string, unknown>> {
  const manifest: unknown = JSON.parse(
    await readFile(join(BUYER, 'package.json'), 'utf8'),
  );
  assert.ok(isRecord(manifest));
  assert.ok(isRecord(manifest.dependencies));
  return manifest;
}

void test('buyer declares every workspace package imported by its source', async () => {
  const manifest = await buyerManifest();
  const dependencies = manifest.dependencies;
  assert.ok(isRecord(dependencies));
  const sourceRoot = join(BUYER, 'src');
  const files = await readdir(sourceRoot, { recursive: true });
  for (const file of files.filter((name) => name.endsWith('.ts'))) {
    const source = ts.createSourceFile(
      file,
      await readFile(join(sourceRoot, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (!specifier.text.startsWith('@gyblos/')) continue;
      const dependency = specifier.text.split('/').slice(0, 2).join('/');
      assert.equal(
        dependencies[dependency],
        'workspace:*',
        `${file} imports undeclared workspace dependency ${dependency}`,
      );
    }
  }
});

void test('buyer resolves its runtime payment adapter using only declared workspace links', async () => {
  const manifest = await buyerManifest();
  const dependencies = manifest.dependencies;
  assert.ok(isRecord(dependencies));
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-buyer-dependencies-'));
  try {
    await mkdir(join(directory, 'node_modules/@gyblos'), { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!name.startsWith('@gyblos/') || specifier !== 'workspace:*') continue;
      await symlink(
        resolve('packages', name.slice('@gyblos/'.length)),
        join(directory, 'node_modules', name),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    // A new process prevents negative-resolution caches from hiding link changes.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import {createRequire} from 'node:module'; " +
          "const require = createRequire(process.cwd() + '/package.json'); " +
          'console.log(require.resolve(process.argv[1]));',
        ADAPTER_ENTRY,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          GYBLOS_HOME: join(directory, 'home'),
          GYBLOS_LAB_HOME: join(directory, 'lab'),
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, 'Buyer dependency resolution must succeed.');
    assert.equal(
      result.stdout.trim(),
      await realpath('packages/payments-upto/src/batch-session.ts'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
