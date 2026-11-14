// Real pooled-session busy proof, synthetic transport and private temporary financial state only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeApiKeySession,
  reserveApiKey,
} from '@gyblos/buyer/api-key-execution';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { BUYER_KEY_CHARGE } from '@gyblos/protocol/buyer-api-keys';

import { multisellerLoopback } from './support/multiseller-session';

void test('a delegated key releases a proven-unsent pooled busy reservation before rerouting', async (t) => {
  const fixture = await multisellerLoopback();
  const buyer = createBuyerSessionPool(fixture.options);
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope: {
      network: fixture.a.terms.network,
      mint: fixture.a.terms.mint,
      payer: fixture.a.terms.buyer,
    },
  });
  t.after(async () => {
    await buyer.close();
    await keys.close();
    await fixture.close();
  });
  const key = await keys.create('Synthetic tools', '1000');
  const operation = keys.operation(key.id);
  const quoteA = await fixture.offers[0]!.quote(1);
  await reserveApiKey(operation, quoteA);
  fixture.offers[0]!.busy(true);
  await assert.rejects(
    executeApiKeySession(operation, quoteA.offer.nodeId, () =>
      buyer.execute(
        quoteA,
        fixture.offers[0]!.input,
        AbortSignal.timeout(3000),
      ),
    ),
    { name: 'UnsentSellerBusyError' },
  );
  assert.equal(await buyer.unresolved(), false);
  assert.deepEqual(fixture.a.calls, []);
  assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
  const quoteB = await fixture.offers[1]!.quote(2);
  await reserveApiKey(operation, quoteB);
  const completed = await executeApiKeySession(
    operation,
    quoteB.offer.nodeId,
    () =>
      buyer.execute(
        quoteB,
        fixture.offers[1]!.input,
        AbortSignal.timeout(3000),
      ),
  );
  await operation.complete(
    completed.approval.approvedAtomic,
    BUYER_KEY_CHARGE.APPROVED,
  );
  assert.equal((await keys.snapshot()).blocked, false);
  assert.equal(
    (await keys.snapshot()).keys[0]?.spentAtomic,
    completed.approval.approvedAtomic,
  );
});
void test('a generic busy-shaped failure cannot release a delegated paid reservation', async () => {
  const keys = await createBuyerApiKeys({
    files: { read: async () => undefined, write: async () => {} },
    scope: {
      network: 'synthetic',
      mint: '1'.repeat(32),
      payer: '2'.repeat(32),
    },
  });
  try {
    const key = await keys.create('Synthetic tools', '100');
    const operation = keys.operation(key.id);
    await operation.reserve({
      maxAtomic: '100',
      requestId: 'synthetic',
      requestDigest: 'a'.repeat(64),
      sellerNodeId: 'b'.repeat(64),
    });
    const failure = Object.assign(new Error('synthetic unknown busy'), {
      name: 'UnsentSellerBusyError',
      nodeId: 'b'.repeat(64),
    });
    await assert.rejects(
      executeApiKeySession(operation, 'b'.repeat(64), async () => {
        throw failure;
      }),
    );
    operation.abandon();
    assert.equal((await keys.snapshot()).blocked, true);
    assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '100');
  } finally {
    await keys.close();
  }
});
