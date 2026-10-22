// Owns synthetic privacy, inventory and command-line regressions.
// All filesystem changes stay inside the test's temporary unfunded fixture.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { analyze } from './analyze.js';
import { fixture, REPOSITORY } from './fixture.js';
import { sourceFiles } from './inventory.js';

function addedCount(text: string): number {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === 'object' && value !== null && 'added' in value);
  assert.ok(Array.isArray(value.added));
  return value.added.length;
}

test('archive enumeration excludes private/generated trees and symlinks before traversal', async () => {
  await fixture(
    {
      'packages/core/src/a.mts': 'export const value = 1;',
      'packages/core/.local/a.ts': 'synthetic private marker',
      'packages/core/dist/a.ts': 'synthetic build output',
      'packages/core/node_modules/a.ts': 'synthetic dependency',
      'lab/evidence/a.ts': 'synthetic evidence',
      '.local/a.ts': 'synthetic private marker',
      'other/a.ts': 'outside explicit roots',
    },
    async (_files, root) => {
      await symlink(join(root, '.local'), join(root, 'packages/core/linked'));
      assert.deepEqual(await sourceFiles(root), ['packages/core/src/a.mts']);
    },
  );
});

test('CLI reports new violations without rewriting baseline and fails analyzer errors', async () => {
  await fixture(
    {
      'package.json': JSON.stringify({ type: 'module' }),
      'packages/core/src/a.ts': "import '../../engine-ollama/src/a.js';",
      'packages/engine-ollama/src/a.ts': 'export const value = 1;',
      'tooling/boundaries-baseline.json': '[]\n',
    },
    async (_files, root) => {
      await mkdir(join(root, 'tooling/boundaries'), { recursive: true });
      for (const file of [
        'check-boundaries.ts',
        'boundaries/analyze.ts',
        'boundaries/config.ts',
        'boundaries/inventory.ts',
        'boundaries/graph.ts',
      ])
        await writeFile(
          join(root, 'tooling', file),
          await readFile(join(REPOSITORY, 'tooling', file)),
        );
      await symlink(
        join(REPOSITORY, 'node_modules'),
        join(root, 'node_modules'),
      );
      const invoke = (...args: string[]) =>
        spawnSync(
          process.execPath,
          ['--import', 'tsx', 'tooling/check-boundaries.ts', ...args],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          },
        );
      const report = invoke('--json');
      assert.equal(report.status, 0, report.stderr);
      assert.equal(addedCount(report.stdout), 1);
      const baseline = join(root, 'tooling/boundaries-baseline.json');
      assert.equal(await readFile(baseline, 'utf8'), '[]\n');
      assert.equal(invoke('--update-baseline').status, 0);
      assert.equal(addedCount(invoke('--json').stdout), 0);
      assert.equal(invoke('--unknown-option').status, 1);
      await writeFile(baseline, '{}');
      assert.equal(invoke().status, 1);
      await writeFile(baseline, '[]');
      await writeFile(
        join(root, 'packages/core/src/a.ts'),
        "import './unresolved-SYNTHETIC-SENSITIVE-MARKER.js';",
      );
      const failed = invoke('--json');
      assert.equal(failed.status, 1);
      assert.equal(failed.stdout, '');
      assert.ok(!failed.stderr.includes('SYNTHETIC-SENSITIVE-MARKER'));
    },
  );
});

test('unmapped transitive shims cannot launder a forbidden dependency', async () => {
  await fixture(
    {
      'packages/core/src/a.ts': "export * from '../../../shim.js';",
      'shim.ts': "export * from './packages/payments-x402/src/a.js';",
      'packages/payments-x402/src/a.ts': 'export const value = 1;',
    },
    async (files, root) => {
      await assert.rejects(
        analyze(
          files.filter((file) => file !== 'shim.ts'),
          root,
        ),
        /Unmapped source/,
      );
    },
  );
});

test('Git enumeration rejects symbolic source files and archive enumeration rejects linked roots', async () => {
  await fixture(
    {
      '.gitignore': 'captures/\n',
      'packages/core/src/a.ts': 'export const value = 1;',
      'captures/synthetic.ts': "import 'node:fs';",
      'captures/owned.ts': "import 'node:fs';",
      'packages/engine-ollama/src/owned.ts': 'export const value = 1;',
    },
    async (_files, root) => {
      execFileSync('git', ['init', '--quiet', root]);
      execFileSync('git', ['add', 'packages/engine-ollama/src/owned.ts'], {
        cwd: root,
      });
      await rm(join(root, 'packages/engine-ollama/src'), { recursive: true });
      await symlink(
        join(root, 'captures'),
        join(root, 'packages/engine-ollama/src'),
      );
      await symlink(
        '../../../captures/synthetic.ts',
        join(root, 'packages/core/src/linked.ts'),
      );
      assert.deepEqual(await sourceFiles(root), ['packages/core/src/a.ts']);
      await rm(join(root, '.git'), { recursive: true, force: true });
      await symlink(join(root, 'captures'), join(root, 'lab'));
      assert.deepEqual(await sourceFiles(root), ['packages/core/src/a.ts']);
      await rm(join(root, 'lab'));
      await symlink(join(root, 'captures/synthetic.ts'), join(root, 'lab'));
      assert.deepEqual(await sourceFiles(root), ['packages/core/src/a.ts']);
    },
  );
});

test('imports cannot make analysis parse a symlink target outside the vetted inventory', async () => {
  await fixture(
    {
      'packages/core/src/a.ts': "import './linked.mjs';",
      'outside-roots/synthetic.mjs': 'import { from ???;',
    },
    async (_files, root) => {
      await symlink(
        '../../../outside-roots/synthetic.mjs',
        join(root, 'packages/core/src/linked.mjs'),
      );
      await assert.rejects(
        analyze(await sourceFiles(root), root),
        /Unmapped source/,
      );
    },
  );
});
