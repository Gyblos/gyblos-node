// The seller's real signing path for a channel opening: the product fee-payer guard (limitedFeePayer)
// wraps the fee payer the SDK uses to simulate and then submit the deposit. Synthetic LiteSVM chain.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit';
import {
  SOLANA_TESTNET_CAIP2,
  TransactionOnchainFailureError,
} from '@x402/svm';

import { batchSessionPathsIn, PROTOCOL_FEE } from '@gyblos/config';
import {
  inspectBatchSession,
  openBatchBuyerBackend,
  openBatchSellerBackend,
} from '@gyblos/payments-upto/batch-session';
import { limitedFeePayer } from '@gyblos/payments-upto/fee-payer';
import {
  PaymentSessionError,
  SESSION_CODES,
  SESSION_STATES,
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
  const sellerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller');
  const seller = await openBatchSellerBackend({
    ...base,
    paths: sellerPaths,
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
  assert.equal(
    error.cause.message,
    'invalid_batch_settlement_svm_settlement_simulation',
  );
  assert.equal(vm.sends(), before, 'nothing was sent');
  // A deposit the seller never broadcast can never land: only the seller's fee payer completes it. The
  // seller keeps no opening, so it never tries to close a channel that does not exist.
  const stored = await inspectBatchSession(sellerPaths);
  assert.equal(stored?.snapshot.channelId, '');
  assert.equal(stored?.snapshot.state, SESSION_STATES.OPENING);
  now = terms.expiresAt + 1;
  assert.equal(await seller.tick(), undefined);
  assert.equal(vm.sends(), before, 'no close was attempted');
  now = terms.expiresAt - 60_000;
  // The same buyer can then open the same channel once the seller can simulate again.
  await seller.dispose();
  const retry = await openBatchSellerBackend({
    ...base,
    paths: sellerPaths,
    feePayer: vm.feePayer,
    authorizer: vm.authorizer,
    signer: vm.signer,
  }).create(terms, payload);
  t.after(() => retry.dispose());
  await retry.open(payload);
  assert.equal(await vm.balance(terms.buyer), 99000n, 'the deposit landed');
});

void test('a settlement still running after the wait gave up keeps the opening, and its deposit lands', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const vm = await nativeVm(() => now, SOLANA_TESTNET_CAIP2);
  const local = sessionNativeRpc(vm);
  const root = await mkdtemp(join(tmpdir(), 'gyb-opening-slow-'));
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
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sellerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller');
  const seller = await openBatchSellerBackend({
    ...base,
    paths: sellerPaths,
    feePayer: vm.feePayer,
    authorizer: vm.authorizer,
    operationMs: 200,
    signer: {
      ...vm.signer,
      // A slow RPC: the simulation answers only after the seller stopped waiting.
      simulateTransaction: async (...args) => {
        await gate;
        return vm.signer.simulateTransaction(...args);
      },
    },
  }).create(terms, payload);
  t.after(() => seller.dispose());
  await assert.rejects(seller.open(payload), {
    code: SESSION_CODES.UNAVAILABLE,
  });
  const kept = await inspectBatchSession(sellerPaths);
  assert.notEqual(kept?.snapshot.channelId, '', 'the opening is kept');
  release();
  for (let i = 0; i < 100 && (await vm.balance(terms.buyer)) !== 99000n; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await vm.balance(terms.buyer), 99000n, 'the deposit landed');
  assert.equal(
    (await inspectBatchSession(sellerPaths))?.snapshot.channelId,
    kept?.snapshot.channelId,
    'the seller still holds the channel it must close',
  );
});

async function freshOpening(t: TestContext, label: string) {
  const now = { value: 1800000000000 };
  t.mock.method(Date, 'now', () => now.value);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const vm = await nativeVm(() => now.value, SOLANA_TESTNET_CAIP2);
  const local = sessionNativeRpc(vm);
  const root = await mkdtemp(join(tmpdir(), `gyb-opening-${label}-`));
  const terms = (expiresAt: number): PaymentSessionTerms => ({
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
    expiresAt,
    withdrawDelaySeconds: 900,
  });
  let rateLimited = false;
  // The seller's RPC, which can answer 429 like a shared public endpoint.
  const rpc = new Proxy(local.rpc, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (rateLimited) throw new Error('HTTP error (429): Too Many Requests');
        return (value as (...items: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const buyerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'buyer');
  const sellerPaths = batchSessionPathsIn({ GYBLOS_HOME: root }, 'seller');
  const buyerFor = async (
    sessionTerms: PaymentSessionTerms,
    paths = buyerPaths,
  ) =>
    openBatchBuyerBackend({
      rpcUrl: 'http://127.0.0.1:9',
      rpc: local.rpc,
      now: () => now.value,
      paths,
      payer: vm.payer,
    }).create(sessionTerms);
  const sellerBackend = (signer = vm.signer) =>
    openBatchSellerBackend({
      rpcUrl: 'http://127.0.0.1:9',
      rpc,
      now: () => now.value,
      paths: sellerPaths,
      feePayer: vm.feePayer,
      authorizer: vm.authorizer,
      signer,
    });
  return {
    vm,
    now,
    terms,
    root,
    buyerFor,
    sellerBackend,
    sellerPaths,
    rateLimit: (on: boolean) => {
      rateLimited = on;
    },
  };
}

void test('a rate-limited chain check before the deposit leaves no ghost: no close, and the buyer opens again', async (t) => {
  const f = await freshOpening(t, 'observe');
  const terms = f.terms(f.now.value + 3600000);
  const buyer = await f.buyerFor(terms);
  t.after(buyer.dispose);
  const payload = await buyer.open();
  const seller = await f.sellerBackend().create(terms, payload);
  t.after(() => seller.dispose());
  const before = f.vm.sends();
  f.rateLimit(true);
  await assert.rejects(seller.open(payload));
  f.rateLimit(false);
  assert.equal(
    (await inspectBatchSession(f.sellerPaths))?.snapshot.channelId,
    '',
  );
  f.now.value = terms.expiresAt + 1;
  assert.equal(await seller.tick(), undefined);
  assert.equal(f.vm.sends(), before, 'no close was attempted');
  f.now.value = terms.expiresAt - 60_000;
  await seller.open(payload);
  assert.equal(await f.vm.balance(terms.buyer), 99000n, 'the deposit landed');
});

void test('a deposit that failed on chain leaves nothing pending, and the buyer opens again with new terms', async (t) => {
  const f = await freshOpening(t, 'onchain');
  const terms = f.terms(f.now.value + 3600000);
  const buyer = await f.buyerFor(terms);
  t.after(buyer.dispose);
  const payload = await buyer.open();
  let failOnChain = true;
  const seller = await f
    .sellerBackend({
      ...f.vm.signer,
      // The deposit lands and fails: nothing executes, and confirmation reports the failure.
      sendTransaction: async (wire, ...rest) =>
        failOnChain
          ? getSignatureFromTransaction(
              getTransactionDecoder().decode(Buffer.from(wire, 'base64')),
            )
          : f.vm.signer.sendTransaction(wire, ...rest),
      confirmTransaction: async (signature, ...rest) => {
        if (failOnChain)
          throw new TransactionOnchainFailureError(
            `synthetic failure of ${signature}`,
          );
        return f.vm.signer.confirmTransaction(signature, ...rest);
      },
    })
    .create(terms, payload);
  t.after(() => seller.dispose());
  await assert.rejects(seller.open(payload));
  failOnChain = false;
  const stored = await inspectBatchSession(f.sellerPaths);
  assert.equal(stored?.snapshot.channelId, '');
  assert.equal(stored?.pending, false);
  // New terms from the same buyer: the seller session renews from its unsigned preparation.
  f.now.value += 60_000;
  const renewed = f.terms(f.now.value + 3600000);
  const nextBuyer = await f.buyerFor(
    renewed,
    batchSessionPathsIn({ GYBLOS_HOME: join(f.root, 'next') }, 'buyer'),
  );
  t.after(nextBuyer.dispose);
  const nextPayload = await nextBuyer.open();
  await seller.dispose();
  const backend = f.sellerBackend();
  await backend.renew!('', renewed, nextPayload);
  const reopened = await backend.create(renewed);
  t.after(() => reopened.dispose());
  await reopened.open(nextPayload);
  assert.equal(
    await f.vm.balance(terms.buyer),
    99000n,
    'the new deposit landed',
  );
});
