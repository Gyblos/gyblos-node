// Startup financial backends and independent observers over the pinned SDK/native program in LiteSVM.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';

import { batchSessionPathsIn, PROTOCOL_FEE } from '@gyblos/config';
import {
  batchSessionObserver,
  openBatchBuyerBackend,
  openBatchSellerBackend,
} from '@gyblos/payments-upto/batch-session';
import {
  SESSION_CODES,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import { nativeVm } from '../support/paid-native-vm';
import { sessionNativeRpc } from '../support/session-native-rpc';

void test('startup backends prove original native opening, cumulative usage and actual finalized refund independently', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const vm = await nativeVm(() => now, SOLANA_TESTNET_CAIP2);
  const local = sessionNativeRpc(vm);
  const root = await mkdtemp(join(tmpdir(), 'gyb-session-backend-native-'));
  const terms: PaymentSessionTerms = {
    buyer: vm.payer.address,
    buyerNodeId: '12'.repeat(32),
    owner: vm.seller.address,
    sellerNodeId: '34'.repeat(32),
    network: vm.network,
    mint: vm.mint.address,
    payTo: vm.seller.address,
    feePayer: vm.feePayer.address,
    authorizer: vm.authorizer.address,
    treasury: vm.fee.address,
    protocolFeeBps: PROTOCOL_FEE.bps,
    depositAtomic: '1000',
    expiresAt: now + 3600000,
    withdrawDelaySeconds: 900,
  };
  const buyerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer');
  const sellerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller');
  const base = { rpcUrl: 'http://127.0.0.1:9', rpc: local.rpc, now: () => now };
  const buyerBackend = openBatchBuyerBackend({
    ...base,
    paths: buyerPaths,
    payer: vm.payer,
  });
  const buyer = await buyerBackend.create(terms);
  t.after(buyer.dispose);
  const payload = await buyer.open();
  const sellerBackend = openBatchSellerBackend({
    ...base,
    paths: sellerPaths,
    feePayer: vm.feePayer,
    authorizer: vm.authorizer,
    signer: vm.signer,
  });
  const seller = await sellerBackend.create(terms, payload);
  t.after(seller.dispose);
  const before = vm.sends();
  const opened = await seller.open(payload);
  assert.equal(vm.sends(), before + 1);
  const observer = batchSessionObserver({ ...base, terms, paths: sellerPaths });
  assert.equal(await observer.opening(JSON.parse(payload)), true);
  assert.equal(await observer.closing(opened.channelId), false);
  const request = {
    requestId: '12'.repeat(16),
    requestDigest: '34'.repeat(32),
    maxAtomic: '200',
  };
  await buyer.begin(request);
  await seller.reserve(request, terms.buyerNodeId);
  const bill = await seller.finish(request.requestId, '40');
  const voucher = await buyer.approve(bill, '40');
  await seller.accept(bill, voucher, terms.buyerNodeId);
  await buyer.acknowledge(request.requestId);
  assert.equal(vm.sends(), before + 1);
  const settled = await seller.close();
  assert.equal(settled.chargedAtomic, '40');
  assert.equal(settled.refundedAtomic, '960');
  assert.deepEqual(await buyer.reconcile(buyerBackend.observe), settled);
  local.hideOriginal(true);
  assert.equal(await observer.settlement(opened.channelId), undefined);
  local.hideOriginal(false);
  local.wrongFee(true);
  await assert.rejects(observer.settlement(opened.channelId), {
    code: SESSION_CODES.UNVERIFIED,
  });
  local.wrongFee(false);
  local.incomplete(true);
  await assert.rejects(observer.settlement(opened.channelId), {
    code: SESSION_CODES.UNVERIFIED,
  });
  local.incomplete(false);
  local.wrongGenesis(true);
  await assert.rejects(observer.settlement(opened.channelId));
  now++;
});
