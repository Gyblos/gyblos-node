// Product paid service and payment adapter meet the real SDK on a simulated channel/RPC.
// Deposit inclusion and native execution are simulated; no network, accounts or funds are touched.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import {
  createUptoAuthorization,
  createUptoSeller,
  memoryUptoStore,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_CHANNEL_STATES,
} from 'x402-upto-metered';

import { UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import {
  createUptoPaymentServer,
  uptoSellerTerms,
  uptoTermsFor,
} from '@gyblos/payments-upto';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import type {
  PaymentDescription,
  PaymentTerms,
} from '@gyblos/protocol/payment';

import { paidSellerFixture } from './support/paid-seller';
import { CLAIM_NOW, sdkClaimFixture } from './support/upto-claim';

async function flow(
  hooks: {
    now?: () => number;
    verified?: () => void;
    persisted?: () => void;
  } = {},
) {
  const sdk = await sdkClaimFixture({ allowClosingClaims: true });
  let deposits = 0;
  const description: PaymentDescription = {
    network: sdk.record.terms.network,
    mint: sdk.record.terms.asset,
    payTo: sdk.record.terms.payTo,
    feePayer: sdk.record.terms.feePayer,
    authorizer: sdk.record.terms.authorizer,
    protocolFeeBps: 300,
    treasury: (await generateKeyPairSigner()).address,
  };
  const store = memoryUptoStore();
  const native = createUptoSeller({
    chain: {
      ...sdk.chain,
      verify: async (...args) => {
        const valid = await sdk.chain.verify(...args);
        hooks.verified?.();
        return valid;
      },
      deposit: async (open, terms) => {
        await sdk.prepareChannel(open, terms);
        deposits++;
        return { transaction: 'simulated-deposit' };
      },
    },
    store: {
      ...store,
      async put(record) {
        await store.put(record);
        if (record.state === UPTO_CHANNEL_STATES.DEPOSITING)
          hooks.persisted?.();
      },
    },
    now: hooks.now ?? (() => CLAIM_NOW),
    own: uptoSellerTerms(description, UPTO_CHANNEL_SETTINGS),
  });
  const server = createUptoPaymentServer({
    description,
    settings: UPTO_CHANNEL_SETTINGS,
    seller: native,
    now: hooks.now ?? (() => CLAIM_NOW),
  });
  const termsFor = (quote: SignedOfferV2): PaymentTerms => ({
    ...description,
    buyer: quote.offer.buyer,
    requestDigest: quote.offer.requestDigest,
    maxAtomic: quote.offer.maxAtomic,
    expiresAt: quote.offer.expiresAt,
  });
  const authorize = async (terms: PaymentTerms) => ({
    ...(await createUptoAuthorization(
      sdk.payer,
      await uptoTermsFor(terms, UPTO_CHANNEL_SETTINGS),
      sdk.hints,
    )),
    requestDigest: terms.requestDigest,
  });
  const seller = await paidSellerFixture({
    payment: server,
    buyer: sdk.payer.address,
    authorize: (quote) => authorize(termsFor(quote)),
  });
  return { sdk, seller, server, store, termsFor, deposits: () => deposits };
}

function shortPayload(payload: string) {
  const decoded: unknown = JSON.parse(
    Buffer.from(payload, 'base64').toString(),
  );
  assert.ok(decoded && typeof decoded === 'object');
  return Buffer.from(
    JSON.stringify({ ...decoded, expiresAt: CLAIM_NOW / 1000 + 21 }),
  ).toString('base64');
}

for (const delayVerification of [true, false]) {
  void test(`claim reserve is rechecked after delayed ${delayVerification ? 'verification' : 'write-ahead persistence'}`, async (context) => {
    context.mock.method(Date, 'now', () => CLAIM_NOW);
    let now = CLAIM_NOW;
    const delay = () => {
      now += 2000;
    };
    const value = await flow({
      now: () => now,
      verified: delayVerification ? delay : undefined,
      persisted: delayVerification ? undefined : delay,
    });
    const request = await value.seller.request();
    const authorization = {
      ...request.payment,
      payload: shortPayload(request.payment.payload),
    };
    await assert.rejects(
      value.server.admit(authorization, value.termsFor(request.quote), {
        minClaimWindowMs: 20_000,
      }),
      { code: PAYMENT_ERROR_CODES.TERMS_EXPIRED },
    );
    assert.equal(value.deposits(), 0);
    assert.equal(value.sdk.sent.length, 0);
    assert.equal(
      (await value.store.get(authorization.channelId))?.state,
      delayVerification ? undefined : UPTO_CHANNEL_STATES.FAILED,
    );
  });
}

void test('quote expiry during write-ahead persistence refuses the deposit and records failure', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  let now = CLAIM_NOW;
  let expiresAt = now;
  const value = await flow({
    now: () => now,
    persisted: () => {
      now = expiresAt;
    },
  });
  const request = await value.seller.request();
  expiresAt = request.quote.offer.expiresAt;
  await assert.rejects(
    value.server.admit(request.payment, value.termsFor(request.quote)),
    { code: PAYMENT_ERROR_CODES.TERMS_EXPIRED },
  );
  assert.equal(value.deposits(), 0);
  assert.equal(
    (await value.store.get(request.payment.channelId))?.state,
    UPTO_CHANNEL_STATES.FAILED,
  );
});

void test('payer closure during product inference still claims exactly delivered usage once through the SDK', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  const value = await flow();
  value.seller.setScript({
    deltas: ['Hi'],
    before: () => {
      value.sdk.fields.status = UPTO_CHANNEL_ACCOUNT.statuses.CLOSING;
      value.sdk.fields.closureStartedAt = BigInt(CLAIM_NOW / 1000);
    },
  });
  const request = await value.seller.request();
  const { terminal, deltas } = await value.seller.execute(request);
  assert.deepEqual(deltas, ['Hi']);
  assert.equal(terminal.charge?.chargedAtomic, '8');
  assert.equal(terminal.payment?.settlement?.chargedAtomic, '8');
  assert.equal(terminal.payment?.settlement?.refundedAtomic, '12');
  assert.equal(value.deposits(), 1);
  assert.equal(value.sdk.sent.length, 1);
  assert.deepEqual(
    value.sdk.sent[0]!.instructions.slice(-2).map((ix) => ix.data[0]),
    [4, 7],
  );
  const replay = await value.seller.execute(request);
  assert.equal(replay.terminal.error?.code, PAID_EXECUTION_CODES.REPLAY);
  assert.equal(value.seller.engineCalls.length, 1);
  assert.equal(value.deposits(), 1);
  assert.equal(value.sdk.sent.length, 1);
});

void test('an authorization too short for the claim reserve is refused before a deposit', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  const value = await flow();
  const request = await value.seller.request();
  const payload: unknown = JSON.parse(
    Buffer.from(request.payment.payload, 'base64').toString(),
  );
  assert.ok(payload && typeof payload === 'object');
  const authorization = {
    ...request.payment,
    payload: Buffer.from(
      JSON.stringify({ ...payload, expiresAt: CLAIM_NOW / 1000 + 1 }),
    ).toString('base64'),
  };
  await assert.rejects(
    value.server.admit(authorization, value.termsFor(request.quote), {
      minClaimWindowMs: 1000,
    }),
    { code: PAYMENT_ERROR_CODES.TERMS_EXPIRED },
  );
  assert.equal(value.deposits(), 0);
  assert.equal(value.seller.engineCalls.length, 0);
  assert.equal(value.sdk.sent.length, 0);
});

void test('paid v2 refuses grace settings that cannot cover the accepted payload window', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  const value = await flow();
  const description = await value.server.describe();
  for (const withdrawDelaySeconds of [60, 180, Number.NaN]) {
    assert.throws(
      () =>
        uptoSellerTerms(description, {
          ...UPTO_CHANNEL_SETTINGS,
          withdrawDelaySeconds,
        }),
      { code: PAYMENT_ERROR_CODES.UNTRUSTED_TERMS },
    );
  }
  assert.equal(value.deposits(), 0);
  assert.equal(value.sdk.sent.length, 0);
});
