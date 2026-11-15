// Server-only recovery of an unsubmitted reservation uses fresh synthetic proof, never a repeated prompt.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config/home';
import { startSellerSessionHost } from '@gyblos/node/seller-session-directory';
import { createBatchBuyer } from '@gyblos/payments-upto/batch-session';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import { batchOfferFixture } from '../support/batch-iroh-offer';
import { sellerRegistryRig } from '../support/seller-session-registry';

void test(
  'expired pristine seller reservation refreshes under the same slot while attempted opening stays protected',
  {
    skip: WINDOWS
      ? 'Reusable financial startup requires payment subtree ACL validation on Windows'
      : false,
  },
  async (t) => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', async () =>
      assert.fail('External RPC forbidden'),
    );
    const rig = await sellerRegistryRig(1, { now: () => now });
    t.after(rig.dispose);
    let registry = await rig.open();
    t.after(() => registry.dispose());
    const row = rig.buyers[0]!;
    const unsubmitted = await registry
      .backend(row.terms.buyerNodeId)
      .create(row.terms, row.payload);
    await unsubmitted.dispose();
    await registry.dispose();
    const before = rig.vm.sends();
    now = row.terms.expiresAt + 1;
    rig.vm.time(Math.floor(now / 1_000));
    registry = await rig.open();
    const terms = { ...row.terms, expiresAt: now + 3_600_000 };
    // Fresh proof is a server test input; this does not claim buyer abandonment of its old signed attempt.
    const hints = rig.vm.hints();
    const fresh = await createBatchBuyer({
      terms,
      payer: row.payer,
      now: rig.now,
      paths: batchSessionPathsIn(
        { GYBLOS_HOME: join(rig.root, 'fresh-synthetic-proof') },
        'buyer',
      ),
      hints: async () => ({
        blockhash: hints.recentBlockhash,
        lastValidBlockHeight: hints.lastValidBlockHeight,
        slot: hints.recentSlot,
      }),
    });
    t.after(fresh.dispose);
    const payload = await fresh.open();
    const offers = await batchOfferFixture(terms, rig.vm.seller, rig.now);
    const host = await startSellerSessionHost({
      buyerNodeIds: [terms.buyerNodeId],
      registry,
      description: terms,
      owner: terms.owner,
      nodeId: terms.sellerNodeId,
      now: rig.now,
      offers: () => [offers.live],
    });
    t.after(host.close);
    const quote = await offers.quote(1);
    const request = (
      method: typeof BATCH_METHODS.PREPARE | typeof BATCH_METHODS.OPEN,
      proposed = terms,
    ) =>
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: 'aa'.repeat(16),
        method,
        params:
          method === BATCH_METHODS.OPEN
            ? { quote, terms: proposed, payload }
            : { quote, terms: proposed },
      });
    const signal = new AbortController().signal;
    await assert.doesNotReject(
      host.service.exchange(
        request(BATCH_METHODS.PREPARE),
        terms.buyerNodeId,
        signal,
      ),
    );
    assert.equal(rig.vm.sends(), before);
    assert.equal(
      await registry.permits(rig.buyers[1]!.terms.buyerNodeId),
      false,
    );
    rig.vm.loseConfirmation(true);
    await assert.rejects(
      host.service.exchange(
        request(BATCH_METHODS.OPEN),
        terms.buyerNodeId,
        signal,
      ),
    );
    assert.equal(await rig.vm.balance(terms.buyer), 99000n);
    await assert.rejects(
      host.service.exchange(
        request(BATCH_METHODS.PREPARE, {
          ...terms,
          expiresAt: terms.expiresAt + 1,
        }),
        terms.buyerNodeId,
        signal,
      ),
      { code: SESSION_CODES.BUSY },
    );
    const sent = rig.vm.sends();
    rig.vm.loseConfirmation(false);
    await host.service.exchange(
      request(BATCH_METHODS.OPEN),
      terms.buyerNodeId,
      signal,
    );
    assert.equal(
      rig.vm.sends(),
      sent,
      'restore only the original opening after its acknowledgment was lost',
    );
    assert.equal(offers.generations(), 0);
  },
);
