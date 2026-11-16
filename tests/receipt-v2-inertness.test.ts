// Imports the new public contract in a fresh test process with network and process effects trapped.
import test from 'node:test';

import { assertImportsInert } from './support/inertness';

void test('paid receipt/v2 import starts no services or network operations', async () => {
  await assertImportsInert(async () => {
    await import('@gyblos/protocol/receipt-v2');
  });
});
