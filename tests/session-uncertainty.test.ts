// A mode change cannot bypass an existing session's committed funds; temporary synthetic homes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buyerPaymentsUnresolved } from '@gyblos/node/buyer-chain';

import { sessionRig } from './support/batch-session';

void test('per-request mode cannot bypass an active reusable channel after configuration changes', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const previous = process.env.GYBLOS_HOME;
  process.env.GYBLOS_HOME = rig.root;
  t.after(() => {
    if (previous === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previous;
  });
  await rig.open();
  assert.equal(await buyerPaymentsUnresolved(), true);
  assert.equal(await buyerPaymentsUnresolved(false), false);
});
