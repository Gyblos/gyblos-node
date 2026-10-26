// Owns offline import-inertness regressions for lab executable entrypoints; product entrypoints are
// checked in tests/entrypoint-inertness.test.ts. No funded wallets or live services.
import test from 'node:test';

import { assertImportsInert } from '../support/inertness.js';
import { NATIVE_CAPABILITY } from '../support/native-runtime.js';

void test('lab executable modules are inert when imported', async (context) => {
  await assertImportsInert(async () => {
    for (const file of [
      '@gyblos/lab-harness/cli/buyer',
      '@gyblos/lab-harness/cli/exact',
      '@gyblos/lab-harness/cli/inference',
      '@gyblos/lab-harness/cli/run',
      '@gyblos/lab-harness/cli/preflight',
      '@gyblos/lab-harness/cli/node-discovery-acceptance',
      '@gyblos/lab-harness/cli/free-acceptance',
      '@gyblos/lab-harness/cli/free-stream-acceptance',
      '@gyblos/lab-harness/commands/seller',
      '@gyblos/lab-harness/commands/challenge',
      '@gyblos/lab-harness/commands/fund',
      '@gyblos/lab-harness/commands/failures',
      '@gyblos/lab-harness/commands/inference-setup',
      '@gyblos/lab-facilitator/main',
    ])
      await import(file);
    await context.test(
      'lab native role setup entry is inert when imported',
      { skip: NATIVE_CAPABILITY.bindingSkip },
      async () => {
        await import('@gyblos/lab-harness/commands/setup');
      },
    );
  });
});
