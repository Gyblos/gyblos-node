// Startup factory failures must release financial resources and remain recoverable without inference.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { batchLoopback } from './support/batch-loopback';
import { sessionRig } from './support/batch-session';

void test('startup cleans a financial handle when host composition rejects its endpoint', async (t) => {
  const rig = await sessionRig();
  await rig.buyer.open();
  const wire = await batchLoopback(
    { exchange: async () => sessionFail() },
    rig.terms,
  );
  let disposed = 0;
  const inspect = () => inspectBatchSession(rig.buyerOptions.paths);
  const manager = createBuyerSessionManager({
    ...wire,
    endpoint: {
      ...wire.endpoint,
      id: () => ({ toString: () => 'ff'.repeat(32) }),
    },
    policy: {
      depositAtomic: '1000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    inspect,
    backend: async () => ({
      inspect,
      observe: async () => undefined,
      create: async () => ({
        ...rig.buyer,
        dispose: async () => {
          disposed++;
        },
      }),
    }),
    destination: () => wire.destination,
    meter: { input: () => 0, count: () => 0 },
    now: rig.now,
    unresolved: async () => false,
    verify: async () => {},
  });
  t.after(async () => {
    await manager.close();
    await wire.close();
    await rig.dispose();
  });
  await assert.rejects(manager.reconcile(new AbortController().signal));
  await manager.close();
  assert.equal(disposed, 1);
});
