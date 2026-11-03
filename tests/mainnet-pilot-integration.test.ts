// Offline probes exercise the pilot guards at each payment port without enabling mainnet in product.
// The loader substitutes the network lock only in this isolated test process; every side effect fails.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

import { generateKeyPairSigner, type TransactionSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS } from '@x402/svm';
import type { UptoSeller } from 'x402-upto-metered';

import { DEVNET, PROTOCOL_FEE, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import type { UptoBuyerJournal } from '@gyblos/payments-upto';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError, type PaymentTerms } from '@gyblos/protocol/payment';

const targets = ['client.ts', 'server.ts'].map(
  (name) =>
    new URL(`../packages/payments-upto/src/${name}`, import.meta.url).href,
);
const real = new URL(
  '../packages/payments-upto/src/mainnet.ts',
  import.meta.url,
).href;
const stub = `export { assertMainnetPilotDeposit } from ${JSON.stringify(real)}; export function assertPaymentNetworkEnabled() {}`;
const loader = `let targets, stub;
export function initialize(data) { ({targets, stub} = data); }
export function resolve(specifier, context, next) {
  if (specifier === './mainnet' && targets.includes(context.parentURL))
    return {url:'data:text/javascript,' + encodeURIComponent(stub), shortCircuit:true};
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, {
  data: { targets, stub },
});
const { createUptoPaymentClient, createUptoPaymentServer } =
  await import('@gyblos/payments-upto');

const fail = () => {
  throw new Error('UNEXPECTED_SIDE_EFFECT');
};
const journal: UptoBuyerJournal = {
  get: fail,
  put: fail,
  remove: fail,
  list: fail,
  close: fail,
};
const error = (value: unknown) =>
  value instanceof PaymentError &&
  value.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS;
const address = async () => (await generateKeyPairSigner()).address;

void test('buyer ceiling is checked before signing or accessing its journal', async () => {
  let signatures = 0;
  const payer: TransactionSigner = {
    address: await address(),
    async signTransactions() {
      signatures++;
      return fail();
    },
  };
  const options = {
    payer,
    policy: {
      network: SOLANA_MAINNET_CAIP2,
      mint: USDC_MAINNET_ADDRESS,
      protocolFeeBps: PROTOCOL_FEE.bps,
      treasury: PROTOCOL_FEE.treasury,
      maxAtomic: '1000001',
    },
    settings: UPTO_CHANNEL_SETTINGS,
    hints: async () => fail(),
    journal,
    confirm: async () => fail(),
    now: () => 0,
  };
  assert.throws(() => createUptoPaymentClient(options), error);
  assert.doesNotThrow(() =>
    createUptoPaymentClient({
      ...options,
      policy: { ...options.policy, maxAtomic: '1000000' },
    }),
  );
  assert.doesNotThrow(() =>
    createUptoPaymentClient({
      ...options,
      policy: { ...options.policy, network: DEVNET },
    }),
  );
  assert.equal(signatures, 0);
});

void test('seller checks both quoted and authorized ceilings before admission', async () => {
  let admissions = 0;
  const seller: UptoSeller = {
    async admit() {
      admissions++;
      return fail();
    },
    settle: async () => fail(),
    recover: async () => fail(),
    record: async () => fail(),
  };
  const description = {
    network: SOLANA_MAINNET_CAIP2,
    mint: USDC_MAINNET_ADDRESS,
    payTo: await address(),
    feePayer: await address(),
    authorizer: await address(),
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: PROTOCOL_FEE.treasury,
  };
  const terms: PaymentTerms = {
    ...description,
    buyer: await address(),
    requestDigest: 'ab'.repeat(32),
    maxAtomic: '1000000',
    expiresAt: 1_800_000_000_000,
  };
  const auth = {
    payer: terms.buyer,
    requestDigest: terms.requestDigest,
    channelId: await address(),
    maxAtomic: '1000000',
    payload: '',
  };
  const server = createUptoPaymentServer({
    description,
    settings: UPTO_CHANNEL_SETTINGS,
    seller,
  });
  await assert.rejects(
    server.admit(auth, { ...terms, maxAtomic: '1000001' }),
    error,
  );
  assert.equal(admissions, 0);
  await assert.rejects(
    server.admit({ ...auth, maxAtomic: '1000001' }, terms),
    error,
  );
  assert.equal(admissions, 0);
  await assert.rejects(server.admit(auth, terms));
  assert.equal(admissions, 1);
  const devnetDescription = { ...description, network: DEVNET };
  const devnet = createUptoPaymentServer({
    description: devnetDescription,
    settings: UPTO_CHANNEL_SETTINGS,
    seller,
  });
  await assert.rejects(
    devnet.admit(
      { ...auth, maxAtomic: '1000001' },
      { ...terms, ...devnetDescription, maxAtomic: '1000001' },
    ),
  );
  assert.equal(admissions, 2);
});
