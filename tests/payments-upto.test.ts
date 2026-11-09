// Adapter-level cases the shared contract cannot reach: shares after a fee change, lapsed claims,
// an unavailable ledger and a malformed network. Real SDK offline, synthetic ledger.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';
import {
  createUptoAuthorization,
  createUptoSeller,
  memoryUptoStore,
  type UptoStore,
} from 'x402-upto-metered';

import { createUptoPaymentServer, uptoTermsFor } from '@gyblos/payments-upto';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentDescription,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import {
  FEE_BPS,
  hints,
  NETWORK,
  newAddress,
  seller,
  SETTINGS,
  START_MS,
} from './support/payment-upto';
import { newLedger } from './support/payment-upto-ledger';

const CEILING = '1000000';
const DIGEST = 'ab'.repeat(32);

async function setup() {
  const ledger = newLedger(Date.now());
  const recent = await hints();
  const payer = await generateKeyPairSigner();
  const description: PaymentDescription = {
    network: NETWORK,
    mint: await newAddress(),
    payTo: await newAddress(),
    feePayer: await newAddress(),
    authorizer: await newAddress(),
    protocolFeeBps: FEE_BPS,
    treasury: await newAddress(),
  };
  const terms: PaymentTerms = {
    ...description,
    buyer: payer.address,
    requestDigest: DIGEST,
    maxAtomic: CEILING,
    expiresAt: ledger.now + 60_000,
  };
  const authorization = {
    ...(await createUptoAuthorization(
      payer,
      await uptoTermsFor(terms, SETTINGS),
      recent,
    )),
    requestDigest: DIGEST,
  };
  return { ledger, recent, description, terms, authorization };
}

const failsWith = (code: string) => (error: unknown) =>
  error instanceof PaymentError && error.code === code;

void test('reported shares follow the distribution the buyer signed, even after a fee change', async () => {
  const { ledger, recent, description, terms, authorization } = await setup();
  const store = memoryUptoStore();
  const options = { failUpstream: false };
  const admission = await seller(
    ledger,
    description,
    recent.recentSlot,
    options,
    store,
  ).admit(authorization, terms);
  // The seller restarts with a different fee while the channel is still open.
  const restarted = seller(
    ledger,
    { ...description, protocolFeeBps: 500 },
    recent.recentSlot,
    options,
    store,
  );
  const settlement = await restarted.settle(admission, '250001');
  const paid = ledger.transactions.get(settlement.transaction);
  assert.equal(settlement.sellerAtomic, paid?.sellerAtomic);
  assert.equal(settlement.feeAtomic, paid?.feeAtomic);
  assert.equal(settlement.sellerAtomic, String((250001n * 9709n) / 10000n));
});

void test('a claim the chain refuses for good lapses, distinct from a retryable failure', async () => {
  const { ledger, recent, description, terms, authorization } = await setup();
  const server = seller(ledger, description, recent.recentSlot, {
    failUpstream: false,
    lapseClaims: true,
  });
  const admission = await server.admit(authorization, terms);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      server.settle(admission, '5'),
      failsWith(PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED),
    );
});

void test('an unavailable ledger is reported as unavailable on admit and settle', async () => {
  const { ledger, recent, description, terms, authorization } = await setup();
  const memory = memoryUptoStore();
  let broken = false;
  const store: UptoStore = {
    get: (channelId) => memory.get(channelId),
    list: () => memory.list(),
    put: async (record) => {
      if (broken) throw new Error('disk full');
      return memory.put(record);
    },
  };
  const server = seller(
    ledger,
    description,
    recent.recentSlot,
    { failUpstream: false },
    store,
  );
  broken = true;
  await assert.rejects(
    server.admit(authorization, terms),
    failsWith(PAYMENT_ERROR_CODES.UNAVAILABLE),
  );
  broken = false;
  const admission = await server.admit(authorization, terms);
  broken = true;
  await assert.rejects(
    server.settle(admission, '5'),
    failsWith(PAYMENT_ERROR_CODES.UNAVAILABLE),
  );
});

void test('a malformed network is refused rather than normalised', async () => {
  const { description } = await setup();
  for (const network of ['solana', 'solana:a:b', ':x'])
    assert.throws(
      () =>
        createUptoPaymentServer({
          description: { ...description, network },
          settings: SETTINGS,
          seller: createUptoSeller({
            chain: {
              verify: async () => false,
              deposit: async () => ({ transaction: '' }),
              depositState: async () => 'never',
              claim: async () => ({ transaction: '' }),
            },
            store: memoryUptoStore(),
            now: () => START_MS,
            own: {
              network: 'solana:x',
              asset: '',
              payTo: '',
              feePayer: '',
              authorizer: '',
              tokenProgram: '',
              withdrawDelaySeconds: 1,
            },
          }),
        }),
      failsWith(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
    );
});

void test('mainnet seller port remains disabled', async () => {
  const { ledger, recent, description } = await setup();
  assert.throws(
    () =>
      seller(
        ledger,
        { ...description, network: SOLANA_MAINNET_CAIP2 },
        recent.recentSlot,
        { failUpstream: false },
      ),
    failsWith(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS),
  );
});

void test('mutating the seller description cannot enable mainnet', async () => {
  const { ledger, recent, description, terms, authorization } = await setup();
  const port = seller(ledger, description, recent.recentSlot, {
    failUpstream: false,
  });
  description.network = SOLANA_MAINNET_CAIP2;
  assert.equal((await port.describe()).network, NETWORK);
  await assert.rejects(
    port.admit(authorization, { ...terms, network: SOLANA_MAINNET_CAIP2 }),
    failsWith(PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH),
  );
  assert.deepEqual(ledger.events, []);
});
