import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';

import { PROTOCOL_FEE } from '@gyblos/config';
import { batchSessionPathsIn } from '@gyblos/config/home';
import { createBuyerSessionManager } from '@gyblos/node/buyer-session';
import { startSellerSessions } from '@gyblos/node/seller-sessions';
import {
  finalizedRequestCharge,
  inspectBatchSession,
  openBatchBuyerBackend,
  openBatchSellerBackend,
} from '@gyblos/payments-upto/batch-session';
import { BUYER_API } from '@gyblos/protocol/buyer-api';

import { batchOfferFixture } from '../support/batch-iroh-offer';
import { batchLoopback } from '../support/batch-loopback';
import { nativeVm } from '../support/paid-native-vm';
import { sessionNativeRpc } from '../support/session-native-rpc';

void test('the managed buyer settles A before funding B and retains spent authority when switching back', async (t) => {
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
  const base = {
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
    depositAtomic: '20000',
    expiresAt: now + 3_600_000,
    withdrawDelaySeconds: 900,
  };
  const buyerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer');

  const common = {
    rpcUrl: 'http://127.0.0.1:9',
    rpc: local.rpc,
    now: () => now,
  };
  const backend = openBatchBuyerBackend({
    ...common,
    paths: buyerPaths,
    payer: vm.payer,
  });
  async function startSeller(sellerNodeId: string) {
    const terms = { ...base, sellerNodeId };
    const offers = await batchOfferFixture(terms, vm.seller, () => now);
    const paths = batchSessionPathsIn(
      { GYBLOS_HOME: join(root, sellerNodeId) },
      'seller',
    );
    const financial = openBatchSellerBackend({
      ...common,
      paths,
      feePayer: vm.feePayer,
      authorizer: vm.authorizer,
      signer: vm.signer,
    });
    const host = await startSellerSessions({
      buyerNodeId: terms.buyerNodeId,
      backend: financial,
      owner: terms.owner,
      nodeId: sellerNodeId,
      description: terms,
      offers: () => [offers.live],
      now: () => now,
    });
    t.after(host.close);
    const wire = await batchLoopback(host.service, terms);
    t.after(wire.close);
    return { wire, offers };
  }
  const a = await startSeller(base.sellerNodeId);
  const b = await startSeller('56'.repeat(32));
  const target = (id: string) => (id === base.sellerNodeId ? a : b);
  let permitted = true;
  const buyer = createBuyerSessionManager<typeof a.wire.destination>({
    endpoint: {
      id: a.wire.endpoint.id,
      connect: (dest, alpn) =>
        target(dest.id().toString()).wire.endpoint.connect(dest, alpn),
    },
    destination: (terms) => target(terms.sellerNodeId).wire.destination,
    policy: {
      depositAtomic: base.depositAtomic,
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    inspect: () => inspectBatchSession(buyerPaths),
    backend: async () => backend,
    meter: a.offers.meter,
    now: () => now,
    verify: async () => {},
    unresolved: async () => false,
    switchingAllowed: async () => permitted,
  });
  t.after(buyer.close);
  async function send(seller: typeof a, id: number) {
    now += 1000;
    return buyer.execute(
      await seller.offers.quote(id),
      seller.offers.input,
      new AbortController().signal,
    );
  }
  await send(a, 1);
  const first = (await inspectBatchSession(buyerPaths))!;
  const binding = {
    requestId: (await a.offers.quote(1)).offer.requestId,
    channelId: first.snapshot.channelId,
    sellerNodeId: base.sellerNodeId,
    baseAtomic: '0',
  };
  const policy = {
    network: base.network,
    mint: base.mint,
    payer: base.buyer,
    version: BUYER_API.VERSION,
    model: 'fixture',
    policyId: 'fixture',
    maxTokens: 100,
    maxAtomic: '200',
  };
  const funded = vm.sends();
  permitted = false;
  await assert.rejects(send(b, 2), { name: 'UnsentSellerBusyError' });
  assert.equal(vm.sends(), funded);
  permitted = true;
  await send(b, 3);
  assert.equal((await inspectBatchSession(buyerPaths))?.priorSpentAtomic, '40');
  assert.equal(
    (await finalizedRequestCharge(buyerPaths, common.rpcUrl, binding, policy))
      ?.chargeAtomic,
    '40',
  );
  assert.equal(
    await finalizedRequestCharge(
      buyerPaths,
      common.rpcUrl,
      { ...binding, requestId: 'ff'.repeat(16) },
      policy,
    ),
    undefined,
  );
  await send(a, 4);
  const restored = await inspectBatchSession(buyerPaths);
  assert.equal(restored?.priorSpentAtomic, '80');
  assert.equal(restored?.terms.depositAtomic, '19920');
  assert.equal(restored?.terms.sellerNodeId, base.sellerNodeId);
});
