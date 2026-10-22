// Owns synthetic architectural policy regressions, separate from product tests.
// It must never execute product modules or initialize an endpoint.
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { analyze, compareBaseline, validateBaseline } from './analyze.js';
import { layerOf } from './config.js';
import { fixture, hasRule } from './fixture.js';
import { parseGraph } from './graph.js';

void test('current and future names map to the intended layers', () => {
  const examples = {
    'packages/application/src/a.ts': 'core',
    'packages/core/src/a.ts': 'core',
    'packages/inference-ollama/src/a.ts': 'adapter',
    'packages/transport/src/a.ts': 'adapter',
    'packages/transport-iroh/src/a.ts': 'adapter',
    'packages/payments-x402/src/a.ts': 'adapter',
    'packages/engine-openai/src/a.ts': 'adapter',
    'packages/discovery-http/src/a.ts': 'adapter',
    'packages/identity/src/a.ts': 'adapter',
    'packages/protocol/src/a.ts': 'protocol',
    'packages/node/src/a.ts': 'node',
    'packages/config/src/a.ts': 'config',
    'packages/runtime/src/a.ts': 'runtime',
    'packages/gate/src/a.ts': 'lab',
    'scripts/main.ts': 'lab',
    'lab/harness/src/a.ts': 'lab',
    'lab/tools/nat-regression.mjs': 'lab',
    'tooling/test.mjs': 'verification',
    'tooling/check-boundaries.ts': 'verification',
    'tests/synthetic.test.ts': 'verification',
    'apps/buyer/src/a.ts': 'apps',
    'apps/desktop/src/a.ts': 'apps',
  };
  for (const [name, layer] of Object.entries(examples))
    assert.equal(layerOf(name), layer);
  assert.equal(layerOf('packages/unmapped/src/a.ts'), null);
});

void test('upper layers may use lower layers, own-package modules and shared support', async () => {
  await fixture(
    {
      'packages/protocol/src/a.ts': 'export const value = 1;',
      'packages/config/src/a.ts': 'export const value = 1;',
      'packages/runtime/src/a.ts': "export * from '../../config/src/a.js';",
      'packages/core/src/a.ts':
        "import '../../protocol/src/a.js'; import '../../config/src/a.js'; import '../../runtime/src/a.js'; export interface Port {}",
      'packages/engine-ollama/src/a.ts':
        "import '../../core/src/a.js'; export interface Engine {}",
      'packages/node/src/a.ts':
        "import '../../engine-ollama/src/a.js'; export const value = 1;",
      'apps/node/src/a.ts':
        "import '../../../packages/node/src/a.js'; import '../../../packages/core/src/a.js';",
      'lab/harness/a.ts': "import '../../apps/node/src/a.js';",
      'tests/a.ts': "import '../lab/harness/a.js';",
      'tooling/verify.mjs': "import '../lab/harness/a.js';",
    },
    async (files, root) =>
      assert.deepEqual((await analyze(files, root)).entries, []),
  );
});

void test('core-to-adapter is detected for relative type-only imports', async () => {
  await fixture(
    {
      'packages/core/src/a.ts':
        "import type { Engine } from '../../engine-ollama/src/a.js'; export type Result = Engine;",
      'packages/engine-ollama/src/a.ts': 'export interface Engine {}',
    },
    async (files, root) =>
      hasRule(await analyze(files, root), 'core-does-not-import-higher-layers'),
  );
});

void test('distinct adapters cannot import each other through reexports', async () => {
  await fixture(
    {
      'packages/engine-ollama/src/a.ts':
        "export * from '../../payments-x402/src/a.js';",
      'packages/payments-x402/src/a.ts': 'export const value = 1;',
    },
    async (files, root) =>
      hasRule(
        await analyze(files, root),
        'adapter-engine-ollama-is-independent',
      ),
  );
});

void test('applications cannot import another app, including literal dynamic imports', async () => {
  await fixture(
    {
      'apps/buyer/src/a.ts':
        "export const load = () => import('../../node/src/a.js');",
      'apps/node/src/a.ts': 'export const value = 1;',
    },
    async (files, root) =>
      hasRule(await analyze(files, root), 'app-buyer-is-independent'),
  );
});

void test('product cannot import lab, scripts, legacy gate or experimental tooling', async () => {
  await fixture(
    {
      'apps/buyer/src/a.ts':
        "import '../../../lab/a.js'; import '../../../scripts/a.js'; import '../../../packages/gate/src/a.js'; import '../../../lab/tools/nat-regression.mjs';",
      'lab/a.ts': 'export const value = 1;',
      'scripts/a.ts': 'export const value = 1;',
      'packages/gate/src/a.ts': 'export const value = 1;',
      'lab/tools/nat-regression.mjs': 'export const value = 1;',
    },
    async (files, root) =>
      assert.equal(
        (await analyze(files, root)).entries.filter(
          (entry) => entry.rule === 'product-does-not-import-lab',
        ).length,
        4,
      ),
  );
});

void test('config and runtime cannot depend on product composition', async () => {
  await fixture(
    {
      'packages/config/src/a.ts': "import '../../runtime/src/b.js';",
      'packages/runtime/src/a.ts': "import '../../core/src/a.js';",
      'packages/runtime/src/b.ts': 'export const value = 1;',
      'packages/core/src/a.ts': 'export const value = 1;',
    },
    async (files, root) => {
      const result = await analyze(files, root);
      hasRule(result, 'config-is-a-leaf');
      hasRule(result, 'runtime-only-uses-config');
    },
  );
});

void test('protocol independence and core filesystem imports are reported', async () => {
  await fixture(
    {
      'packages/protocol/src/a.ts': "import '../../config/src/a.js';",
      'packages/config/src/a.ts': 'export const value = 1;',
      'packages/core/src/a.ts':
        "import { readFile } from 'node:fs/promises'; export { readFile };",
    },
    async (files, root) => {
      const result = await analyze(files, root);
      hasRule(result, 'protocol-is-independent');
      hasRule(result, 'domain-has-no-filesystem');
    },
  );
});

void test('SDK imports remain visible without traversing their implementation', async () => {
  await fixture(
    {
      'packages/core/src/a.ts':
        "import { value } from '@solana/kit'; export { value };",
      'packages/protocol/src/a.ts':
        "import { value } from '@solana/kit'; export { value };",
      'node_modules/@solana/kit/package.json': JSON.stringify({
        name: '@solana/kit',
        version: '1.0.0',
        main: 'dist/index.js',
      }),
      'node_modules/@solana/kit/dist/index.js':
        "import './must-not-be-followed.js'; export const value = 1;",
    },
    async (files, root) => {
      const result = await analyze(files, root);
      hasRule(result, 'domain-has-no-sdk');
      hasRule(result, 'protocol-has-no-sdk');
      assert.ok(
        result.entries.every((entry) => entry.target === '@solana/kit'),
      );
    },
  );
});

void test('workspace package exports and relative paths resolve to identical ownership', async () => {
  await fixture(
    {
      'packages/core/src/a.ts':
        "export * from '@gyblos/engine-ollama'; export * from '../../engine-ollama/src/a.js';",
      'packages/engine-ollama/src/a.ts': 'export interface Engine {}',
      'packages/engine-ollama/package.json': JSON.stringify({
        name: '@gyblos/engine-ollama',
        version: '1.0.0',
        exports: './src/a.ts',
      }),
    },
    async (files, root) => {
      await mkdir(join(root, 'node_modules/@gyblos'), { recursive: true });
      await symlink(
        '../../packages/engine-ollama',
        join(root, 'node_modules/@gyblos/engine-ollama'),
      );
      const result = await analyze(files, root);
      hasRule(result, 'core-does-not-import-higher-layers');
      assert.ok(
        result.entries.some(
          (entry) => entry.target === 'packages/engine-ollama/src/a.ts',
        ),
      );
    },
  );
});

void test('unresolved imports, unknown packages and empty scans fail analysis', async () => {
  await fixture(
    { 'packages/core/src/a.ts': "import './missing.js';" },
    async (files, root) => {
      await assert.rejects(analyze(files, root), /Unresolved import/);
      await assert.rejects(analyze([], root), /No source files/);
      await assert.rejects(
        analyze(['packages/unknown/src/a.ts'], root),
        /Unmapped source/,
      );
    },
  );
});

void test('source code is never executed and existing baseline differences are explicit', async () => {
  await fixture(
    {
      'packages/core/src/a.ts':
        "throw new Error('Product code must not execute');",
    },
    async (files, root) => {
      assert.deepEqual((await analyze(files, root)).entries, []);
    },
  );
  const oldEntry = { rule: 'example', source: 'apps/a.ts', target: 'lab/a.ts' };
  const newEntry = { rule: 'example', source: 'apps/b.ts', target: 'lab/b.ts' };
  assert.deepEqual(compareBaseline([newEntry], [oldEntry]), {
    current: 1,
    baseline: 1,
    added: [newEntry],
    resolved: [oldEntry],
  });
  assert.throws(() => validateBaseline([oldEntry, oldEntry]), /Duplicate/);
  for (const target of [
    '/private/tmp/a',
    '../outside.ts',
    '.local/key.ts',
    'lab/evidence/run.json',
  ])
    assert.throws(() => validateBaseline([{ ...oldEntry, target }]), /Invalid/);
  assert.throws(() => validateBaseline({}), /Invalid/);
  assert.deepEqual(parseGraph('{"modules":[],"summary":{"violations":[]}}'), {
    modules: [],
    summary: { violations: [] },
  });
  for (const text of [
    '{}',
    '{"modules":[{"source":1,"dependencies":[]}],"summary":{"violations":[]}}',
    '{"modules":[{"source":"a.ts","dependencies":[{}]}],"summary":{"violations":[]}}',
    '{"modules":[],"summary":{"violations":[{}]}}',
  ])
    assert.throws(() => parseGraph(text), /Invalid dependency analysis/);
});
