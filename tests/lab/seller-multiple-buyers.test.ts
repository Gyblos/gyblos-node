// Product session hosts authenticate two buyers over loopback while their channels run in native LiteSVM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { startSellerSessionHost } from '@gyblos/node/seller-session-directory';
import { openBatchBuyerBackend } from '@gyblos/payments-upto/batch-session';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import { batchOfferFixture } from '../support/batch-iroh-offer';
import { batchLoopback } from '../support/batch-loopback';
import { sellerRegistryRig } from '../support/seller-session-registry';

void test(
  'two pilot buyers execute on one seller without mixing deposits, approvals or authenticated peers',
  {
    skip: WINDOWS
      ? 'Reusable financial startup requires payment subtree ACL validation on Windows'
      : false,
  },
  async (t) => {
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    t.mock.method(globalThis, 'fetch', async () =>
      assert.fail('External RPC forbidden'),
    );
    const rig = await sellerRegistryRig(2);
    t.after(rig.dispose);
    const registry = await rig.open();
    t.after(registry.dispose);
    const a = rig.buyers[0]!;
    const b = rig.buyers[1]!;
    const offers = await Promise.all(
      [a, b].map((row) => batchOfferFixture(row.terms, rig.vm.seller, rig.now)),
    );
    const seller = await startSellerSessionHost({
      buyerNodeIds: [a.terms.buyerNodeId, b.terms.buyerNodeId],
      registry,
      description: a.terms,
      owner: a.terms.owner,
      nodeId: a.terms.sellerNodeId,
      now: rig.now,
      offers: () => [offers[0]!.live],
    });
    t.after(seller.close);
    const clients = [];
    for (const [index, row] of [a, b].entries()) {
      await row.buyer.dispose();
      const wire = await batchLoopback(seller.service, row.terms);
      t.after(wire.close);
      const backend = openBatchBuyerBackend({
        ...rig.options,
        paths: row.paths,
        payer: row.payer,
      });
      const manager = createBuyerSessionManager({
        endpoint: wire.endpoint,
        destination: () => wire.destination,
        policy: {
          depositAtomic: '1000',
          lifetimeMs: 3_600_000,
          withdrawDelaySeconds: 900,
        },
        backend: async () => backend,
        inspect: backend.inspect,
        meter: offers[index]!.meter,
        now: rig.now,
        unresolved: async () => false,
        verify: async () => {},
      });
      t.after(manager.close);
      clients.push(manager);
    }
    const signal = new AbortController().signal;
    const baseline = rig.vm.sends();
    await assert.doesNotReject(
      clients[0]!.execute(await offers[0]!.quote(1), offers[0]!.input, signal),
    );
    await assert.doesNotReject(
      clients[1]!.execute(await offers[1]!.quote(1), offers[1]!.input, signal),
    );
    assert.equal(offers[0]!.generations(), 2);
    assert.equal(
      offers[1]!.generations(),
      0,
      'one shared seller engine serves both authenticated buyers',
    );
    assert.equal(rig.vm.sends(), baseline + 2);
    const saved = await registry.list();
    const first = saved.find((row) => row.buyerNodeId === a.terms.buyerNodeId)!;
    const second = saved.find(
      (row) => row.buyerNodeId === b.terms.buyerNodeId,
    )!;
    assert.notEqual(
      first.stored.snapshot.channelId,
      second.stored.snapshot.channelId,
    );
    assert.equal(first.stored.snapshot.cumulativeAtomic, '40');
    assert.equal(second.stored.snapshot.cumulativeAtomic, '40');
    const request = (channelId: string) =>
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: 'fe'.repeat(16),
        method: BATCH_METHODS.SNAPSHOT,
        params: { channelId },
      });
    await assert.rejects(
      seller.service.exchange(
        request(second.stored.snapshot.channelId),
        a.terms.buyerNodeId,
        signal,
      ),
      { code: SESSION_CODES.BINDING },
    );
    await assert.rejects(
      seller.service.exchange(
        request(first.stored.snapshot.channelId),
        rig.buyers[2]!.terms.buyerNodeId,
        signal,
      ),
      { code: PAID_EXECUTION_CODES.PEER },
    );
    assert.equal(rig.vm.sends(), baseline + 2);
    assert.equal((await clients[0]!.settle(signal))?.chargedAtomic, '40');
    assert.equal(
      (await registry.backend(b.terms.buyerNodeId).inspect())?.snapshot
        .cumulativeAtomic,
      '40',
    );
    assert.equal(
      await registry.permits(rig.buyers[2]!.terms.buyerNodeId),
      true,
    );
  },
);
