// The seller's real signing path for a channel opening: the product fee-payer guard (limitedFeePayer)
// wraps the fee payer the SDK uses to simulate and then submit the deposit. Synthetic LiteSVM chain.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';

import { batchSessionPathsIn, PROTOCOL_FEE } from '@gyblos/config';
import {
  openBatchBuyerBackend,
  openBatchSellerBackend,
} from '@gyblos/payments-upto/batch-session';
import { limitedFeePayer } from '@gyblos/payments-upto/fee-payer';
import {
  PaymentSessionError,
  SESSION_CODES,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import { nativeVm } from '../support/paid-native-vm';
import { sessionNativeRpc } from '../support/session-native-rpc';

void test('a seller whose fee payer carries the product guard opens a genuine channel', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const vm = await nativeVm(() => now, SOLANA_TESTNET_CAIP2);
  const local = sessionNativeRpc(vm);
  const root = await mkdtemp(join(tmpdir(), 'gyb-opening-guard-'));
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
  const base = { rpcUrl: 'http://127.0.0.1:9', rpc: local.rpc, now: () => now };
  const buyer = await openBatchBuyerBackend({
    ...base,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer'),
    payer: vm.payer,
  }).create(terms);
  t.after(buyer.dispose);
  const payload = await buyer.open();
  // As in production (toFacilitatorSvmSigner(limitedFeePayer(feePayer))), every fee-payer signature the
  // SDK asks for, the pre-submission simulation included, goes through the guard.
  const seller = await openBatchSellerBackend({
    ...base,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller'),
    feePayer: vm.feePayer,
    authorizer: vm.authorizer,
    signer: { ...vm.signer, getSigner: () => limitedFeePayer(vm.feePayer) },
  }).create(terms, payload);
  t.after(() => seller.dispose());
  const before = vm.sends();
  await seller.open(payload);
  assert.ok(vm.sends() > before, 'the deposit was submitted');
  assert.equal(await vm.balance(terms.buyer), 99000n, 'the deposit landed');
});

void test('a deposit the seller cannot simulate fails with the SDK error kept as the cause', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const vm = await nativeVm(() => now, SOLANA_TESTNET_CAIP2);
  const local = sessionNativeRpc(vm);
  const root = await mkdtemp(join(tmpdir(), 'gyb-opening-cause-'));
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
  const base = { rpcUrl: 'http://127.0.0.1:9', rpc: local.rpc, now: () => now };
  const buyer = await openBatchBuyerBackend({
    ...base,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer'),
    payer: vm.payer,
  }).create(terms);
  t.after(buyer.dispose);
  const payload = await buyer.open();
  const seller = await openBatchSellerBackend({
    ...base,
    paths: batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller'),
    feePayer: vm.feePayer,
    authorizer: vm.authorizer,
    signer: {
      ...vm.signer,
      simulateTransaction: async () => {
        throw new Error('synthetic simulation refusal');
      },
    },
  }).create(terms, payload);
  t.after(() => seller.dispose());
  const before = vm.sends();
  const error = await seller.open(payload).then(
    () => assert.fail('the opening must fail'),
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof PaymentSessionError);
  assert.equal(error.code, SESSION_CODES.UNAVAILABLE);
  assert.ok(error.cause instanceof Error);
  assert.match(
    error.cause.message,
    /^invalid_batch_settlement_svm_settlement_simulation:/,
  );
  assert.equal(vm.sends(), before, 'nothing was sent');
});
