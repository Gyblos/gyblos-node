// Shared buyer startup policy uses one SDK-backed synthetic session; no existing wallets or RPC.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROTOCOL_FEE } from '@gyblos/config';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { startSellerSessions } from '@gyblos/node/seller-sessions';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { batchLoopback } from './support/batch-loopback';
import { sessionRig } from './support/batch-session';

void test('shared startup manager executes three prompts with one capped deposit and approved cumulative totals', async (t) => {
  const rig = await sessionRig({
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
    treasury: PROTOCOL_FEE.treasury,
  });
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  let created = 0;
  const seller = await startSellerSessions({
    buyerNodeId: rig.terms.buyerNodeId,
    owner: rig.terms.owner,
    nodeId: rig.terms.sellerNodeId,
    description: rig.terms,
    offers: () => [offers.live],
    now: rig.now,
    backend: {
      inspect: async () => undefined,
      create: async () => rig.seller(),
    },
  });
  const wire = await batchLoopback(seller.service, rig.terms);
  const inspect = () => inspectBatchSession(rig.buyerOptions.paths);
  const manager = createBuyerSessionManager({
    ...wire,
    policy: {
      depositAtomic: '1000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    inspect,
    backend: async () => ({
      inspect,
      create: async () => {
        created++;
        return rig.buyer;
      },
      observe: rig.sellerOptions.observe,
    }),
    destination: () => wire.destination,
    meter: offers.meter,
    now: rig.now,
    unresolved: async () => false,
    verify: async () => {},
  });
  t.after(async () => {
    await manager.close();
    await wire.close();
    await seller.close();
    await rig.dispose();
  });
  await assert.rejects(
    manager.execute(
      await offers.quote(99),
      {
        ...offers.input,
        messages: [...offers.input.messages, ...offers.input.messages],
      },
      new AbortController().signal,
    ),
    { code: PAID_EXECUTION_CODES.UNSUPPORTED },
  );
  assert.equal(
    created,
    0,
    'unsupported input must not construct financial services',
  );
  for (let index = 1; index <= 3; index++) {
    const result = await manager.execute(
      await offers.quote(index),
      offers.input,
      new AbortController().signal,
    );
    assert.ok(result);
    assert.equal(result.value.text, 'ok!');
    assert.equal(result.approval.approvedAtomic, '40');
    assert.equal(result.approval.cumulativeAtomic, String(index * 40));
  }
  assert.equal(created, 1);
  assert.equal(offers.generations(), 3);
  assert.deepEqual(rig.calls, ['deposit']);
});
