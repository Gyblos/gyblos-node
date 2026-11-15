// Product buyer/seller renewal over loopback and the native SDK program; every financial service is local.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';

import { PROTOCOL_FEE } from '@gyblos/config';
import { batchPoolPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { startSellerSessions } from '@gyblos/node/seller-sessions';
import {
  batchSessionTerminal,
  inspectBatchPool,
  inspectBatchSession,
  openBatchBuyerBackend,
  openBatchSellerBackend,
} from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { WINDOWS } from '@gyblos/runtime/private-mode';

import {
  blockTestMeter,
  configureBlockEngine,
} from '../support/batch-block-product';
import { batchOfferFixture } from '../support/batch-iroh-offer';
import { batchLoopback } from '../support/batch-loopback';
import { nativeVm } from '../support/paid-native-vm';
import { sessionNativeRpc } from '../support/session-native-rpc';

for (const blocks of [false, true]) {
  void test(
    `one pilot pair (${blocks ? 'v5' : 'v4'}) renews only after proved refunds and retains historical spending across restart`,
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
      const vm = await nativeVm(() => now, SOLANA_TESTNET_CAIP2, {
        treasury: PROTOCOL_FEE.treasury,
      });
      const local = sessionNativeRpc(vm);
      const root = await mkdtemp(join(tmpdir(), 'gyb-renewal-native-'));
      const terms = {
        buyer: vm.payer.address,
        buyerNodeId: '12'.repeat(32),
        owner: vm.seller.address,
        sellerNodeId: '34'.repeat(32),
        network: vm.network,
        mint: vm.mint.address,
        payTo: vm.seller.address,
        feePayer: vm.feePayer.address,
        authorizer: vm.authorizer.address,
        treasury: PROTOCOL_FEE.treasury,
        protocolFeeBps: PROTOCOL_FEE.bps,
        depositAtomic: '1000',
        expiresAt: now + 3_600_000,
        withdrawDelaySeconds: 900,
      };
      const buyerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer');
      const sellerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller');
      const common = {
        rpcUrl: 'http://127.0.0.1:9',
        rpc: local.rpc,
        now: () => now,
      };
      const buyerBackend = openBatchBuyerBackend({
        ...common,
        paths: buyerPaths,
        payer: vm.payer,
      });
      const sellerBackend = openBatchSellerBackend({
        ...common,
        paths: sellerPaths,
        feePayer: vm.feePayer,
        authorizer: vm.authorizer,
        signer: vm.signer,
      });
      const offers = await batchOfferFixture(terms, vm.seller, () => now);
      if (blocks) configureBlockEngine(offers);
      const charge = blocks ? 80 : 40;
      const seller = await startSellerSessions({
        buyerNodeId: terms.buyerNodeId,
        backend: sellerBackend,
        owner: terms.owner,
        nodeId: terms.sellerNodeId,
        description: terms,
        offers: () => [offers.live],
        now: () => now,
      });
      t.after(seller.close);
      const wire = await batchLoopback(seller.service, terms, blocks);
      t.after(wire.close);
      const start = () =>
        createBuyerSessionManager({
          endpoint: wire.endpoint,
          destination: () => wire.destination,
          policy: {
            depositAtomic: '1000',
            lifetimeMs: 3_600_000,
            withdrawDelaySeconds: 900,
          },
          inspect: () => inspectBatchSession(buyerPaths),
          backend: async () => buyerBackend,
          meter: blocks ? blockTestMeter : offers.meter,
          now: () => now,
          unresolved: async () =>
            (
              await inspectBatchPool(batchPoolPathsIn({ GYBLOS_HOME: root }), {
                includeLegacy: false,
              })
            ).some(
              (entry) =>
                !entry.stored ||
                entry.uncertain ||
                !batchSessionTerminal(entry.stored),
            ),
          verify: async () => {},
        });
      let buyer = start();
      t.after(() => buyer.close());
      const signal = () => new AbortController().signal;
      await buyer.execute(await offers.quote(1), offers.input, signal());
      const first = await inspectBatchSession(buyerPaths);
      assert.ok(first);
      assert.equal(
        (await buyer.settle(signal()))?.chargedAtomic,
        String(charge),
      );
      const beforeRenew = vm.sends();
      now += 1_000;
      local.hideOriginal(true);
      await assert.rejects(
        buyer.execute(await offers.quote(20), offers.input, signal()),
        { code: SESSION_CODES.UNVERIFIED },
      );
      assert.equal(
        vm.sends(),
        beforeRenew,
        'missing finalized proof cannot authorize a new deposit',
      );
      assert.equal(offers.generations(), 1);
      local.hideOriginal(false);
      await buyer.execute(await offers.quote(2), offers.input, signal());
      const second = await inspectBatchSession(buyerPaths);
      assert.ok(second);
      assert.notEqual(second.snapshot.channelId, first.snapshot.channelId);
      assert.equal(second.terms.depositAtomic, String(1000 - charge));
      assert.equal(second.priorSpentAtomic, String(charge));
      assert.equal(
        vm.sends(),
        beforeRenew + 1,
        'exactly one new deposit, no transaction for usage',
      );
      assert.equal(offers.generations(), 2);
      await buyer.close();
      buyer = start();
      now += 1_000;
      await buyer.execute(await offers.quote(3), offers.input, signal());
      assert.equal(
        (await inspectBatchSession(buyerPaths))?.snapshot.channelId,
        second.snapshot.channelId,
      );
      assert.equal(vm.sends(), beforeRenew + 1);
      const beforeExpiry = vm.sends();
      now += 3_600_000;
      vm.time(Math.floor(now / 1_000));
      await buyer.execute(await offers.quote(4), offers.input, signal());
      const third = await inspectBatchSession(buyerPaths);
      assert.ok(third);
      assert.notEqual(third.snapshot.channelId, second.snapshot.channelId);
      assert.equal(third.terms.depositAtomic, String(1000 - 3 * charge));
      assert.equal(third.priorSpentAtomic, String(3 * charge));
      assert.equal(
        vm.sends(),
        beforeExpiry + 2,
        'expired channel is closed before exactly one replacement opens',
      );
      assert.equal(
        (await buyer.settle(signal()))?.chargedAtomic,
        String(charge),
      );
      const raw = JSON.parse(await readFile(buyerPaths.state, 'utf8'));
      assert.equal(raw.history.length, 2);
      assert.equal(
        raw.history[0].settlement.refundedAtomic,
        String(1000 - charge),
      );
      const beforeRefusal = vm.sends();
      const oversized = await offers.quote(5, { maxAtomic: '900' });
      await assert.rejects(buyer.execute(oversized, offers.input, signal()), {
        code: SESSION_CODES.LIMIT,
      });
      assert.equal(vm.sends(), beforeRefusal);
      assert.equal(offers.generations(), 4);
    },
  );
}
