// Owns offline import-inertness regressions for lab executable entrypoints; product entrypoints are
// checked in tests/entrypoint-inertness.test.ts. No funded wallets or live services.
import test from 'node:test';

import { assertImportsInert } from '../support/inertness';

void test('lab executable modules are inert when imported', async () => {
  await assertImportsInert(async () => {
    for (const file of [
      '@gyblos/lab-harness/cli/node-discovery-acceptance',
      '@gyblos/lab-harness/cli/free-acceptance',
      '@gyblos/lab-harness/cli/free-stream-acceptance',
      '@gyblos/lab-harness/cli/identity-acceptance',
      '@gyblos/lab-harness/cli/receipt-acceptance',
      '@gyblos/lab-harness/acceptance/receipts',
      '@gyblos/lab-harness/acceptance/tools',
      '@gyblos/lab-harness/acceptance/receipt-collector-worker',
      '@gyblos/lab-harness/commands/batch-channel-check',
    ])
      await import(file);
  });
});
