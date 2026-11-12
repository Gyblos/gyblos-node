// Architectural contract for the shared inference orchestrator; synthetic source only, never runtime code.
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyze } from './analyze';
import { layerOf } from './config';
import { fixture, hasRule } from './fixture';

void test('inference owns its application-service layer', () => {
  assert.equal(layerOf('packages/inference/src/execution.ts'), 'inference');
});
void test('node uses inference through protocol ports and core policy', async () => {
  await fixture(
    {
      'packages/protocol/src/a.ts': 'export interface Engine {}',
      'packages/core/src/a.ts': 'export interface Policy {}',
      'packages/inference/src/a.ts':
        "import type { Engine } from '../../protocol/src/a'; import type { Policy } from '../../core/src/a'; export interface Run { engine: Engine; policy: Policy }",
      'packages/node/src/a.ts': "export * from '../../inference/src/a';",
    },
    async (files, root) =>
      assert.deepEqual((await analyze(files, root)).entries, []),
  );
});
void test('inference cannot import concrete adapters or hosts', async () => {
  await fixture(
    {
      'packages/inference/src/a.ts':
        "import '../../engine-ollama/src/a'; import '../../node/src/a'; import '../../../apps/buyer/src/a';",
      'packages/engine-ollama/src/a.ts': 'export {};',
      'packages/node/src/a.ts': 'export {};',
      'apps/buyer/src/a.ts': 'export {};',
    },
    async (files, root) => {
      const result = await analyze(files, root);
      assert.equal(
        result.entries.filter(
          (entry) => entry.rule === 'inference-only-uses-domain',
        ).length,
        3,
      );
    },
  );
});
void test('core and adapters cannot import the inference orchestrator', async () => {
  await fixture(
    {
      'packages/core/src/a.ts': "import '../../inference/src/a';",
      'packages/engine-ollama/src/a.ts': "import '../../inference/src/a';",
      'packages/inference/src/a.ts': 'export {};',
    },
    async (files, root) => {
      const result = await analyze(files, root);
      hasRule(result, 'core-does-not-import-higher-layers');
      hasRule(result, 'adapters-do-not-import-composition');
    },
  );
});
void test('inference imports neither filesystem nor SDKs', async () => {
  await fixture(
    {
      'packages/inference/src/a.ts':
        "import 'node:fs/promises'; import { Tokenizer } from '@huggingface/tokenizers'; export { Tokenizer };",
      'node_modules/@huggingface/tokenizers/package.json': JSON.stringify({
        name: '@huggingface/tokenizers',
        version: '1.0.0',
        main: 'index.js',
      }),
      'node_modules/@huggingface/tokenizers/index.js':
        'export class Tokenizer {}',
    },
    async (files, root) => {
      const result = await analyze(files, root);
      hasRule(result, 'domain-has-no-filesystem');
      hasRule(result, 'domain-has-no-sdk');
    },
  );
});
