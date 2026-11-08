// Product paid service and payment adapter meet the real SDK on a simulated channel/RPC.
// Deposit inclusion and native execution are simulated; no network, accounts or funds are touched.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';

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
  context: TestContext,
  hooks: {
    now?: () => number;
    verified?: () => void | Promise<void>;
    confirm?: () => Promise<void>;
    persisted?: () => void;
  } = {},
) {
  // SDK crypto may outlive a 50 ms host tick; advance service deadlines explicitly.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const sdk = await sdkClaimFixture({
    allowClosingClaims: true,
    confirm: hooks.confirm,
  });
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
        await hooks.verified?.();
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
    const value = await flow(context, {
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
  const value = await flow(context, {
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
  const value = await flow(context);
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

for (const phase of ['verification', 'confirmation']) {
  void test(`closure settles once when SDK ${phase} takes longer than the fixture wait in host time`, async (context) => {
    context.mock.method(Date, 'now', () => CLAIM_NOW);
    // Capture the host clock before the fixture virtualizes service timeouts.
    const hostTimeout = setTimeout;
    const pause = () =>
      new Promise<void>((resolve) => hostTimeout(resolve, 51));
    const value = await flow(context, {
      verified: phase === 'verification' ? pause : undefined,
      confirm: phase === 'confirmation' ? pause : undefined,
    });
    value.seller.setScript({
      deltas: ['Hi'],
      before: () => {
        value.sdk.fields.status = UPTO_CHANNEL_ACCOUNT.statuses.CLOSING;
        value.sdk.fields.closureStartedAt = BigInt(CLAIM_NOW / 1000);
      },
    });
    const { terminal, deltas } = await value.seller.execute(
      await value.seller.request(),
    );
    assert.deepEqual(deltas, ['Hi']);
    assert.equal(terminal.payment?.settlement?.chargedAtomic, '8');
    assert.equal(terminal.payment?.settlement?.refundedAtomic, '12');
    assert.equal(value.deposits(), 1);
    assert.equal(value.sdk.sent.length, 1);
    assert.deepEqual(value.seller.pending, []);
    assert.equal(value.seller.engineCalls.length, 1);
  });
}

for (const phase of ['verification', 'confirmation']) {
  void test(
    `the unchanged payment wait expires at its exact boundary during SDK ${phase}`,
    { timeout: 15000 },
    async (context) => {
      context.mock.method(Date, 'now', () => CLAIM_NOW);
      let entered = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pause = async () => {
        entered();
        await held;
      };
      const value = await flow(context, {
        verified: phase === 'verification' ? pause : undefined,
        confirm: phase === 'confirmation' ? pause : undefined,
      });
      value.seller.setScript({
        deltas: ['Hi'],
        before: () => {
          value.sdk.fields.status = UPTO_CHANNEL_ACCOUNT.statuses.CLOSING;
          value.sdk.fields.closureStartedAt = BigInt(CLAIM_NOW / 1000);
        },
      });
      let claim: ReturnType<typeof value.server.settle> | undefined;
      const settle = value.server.settle;
      context.mock.method(
        value.server,
        'settle',
        (...args: Parameters<typeof settle>) => {
          claim = settle(...args);
          return claim;
        },
      );
      const pending = new Promise<{ chargedAtomic: string }>((resolve) => {
        value.seller.setPendingHook((_admission, chargedAtomic) =>
          resolve({ chargedAtomic }),
        );
      });
      const request = await value.seller.request();
      let complete = false;
      const stream = value.seller.service.stream;
      // Observe the service itself, before the fixture's asynchronous buyer verification.
      context.mock.method(
        value.seller.service,
        'stream',
        async (...args: Parameters<typeof stream>) => {
          const terminal = await stream(...args);
          complete = true;
          return terminal;
        },
      );
      const running = value.seller.execute(request);
      try {
        await started;
        assert.equal(value.seller.options.settlement.waitMs, 50);
        context.mock.timers.tick(value.seller.options.settlement.waitMs - 1);
        await yieldTurn();
        assert.equal(complete, false);
        context.mock.timers.tick(1);
        const { terminal, deltas } = await running;
        if (phase === 'verification') {
          assert.equal(
            terminal.error?.code,
            PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE,
          );
          assert.deepEqual(deltas, []);
          assert.equal(value.seller.engineCalls.length, 0);
          assert.equal(value.deposits(), 0);
          assert.equal(value.sdk.sent.length, 0);
          release();
          assert.deepEqual(await pending, { chargedAtomic: '0' });
          assert.equal(value.deposits(), 1);
        } else {
          assert.deepEqual(deltas, ['Hi']);
          assert.equal(terminal.payment?.settlement, undefined);
          assert.equal(terminal.payment?.pending?.chargedAtomic, '8');
          assert.deepEqual(await pending, { chargedAtomic: '8' });
          release();
          assert.ok(claim);
          assert.equal((await claim).chargedAtomic, '8');
          assert.equal((await claim).refundedAtomic, '12');
          assert.equal(value.seller.engineCalls.length, 1);
          assert.equal(value.deposits(), 1);
          assert.equal(value.sdk.sent.length, 1);
        }
        const replay = await value.seller.execute(request);
        assert.equal(replay.terminal.error?.code, PAID_EXECUTION_CODES.REPLAY);
        assert.equal(value.sdk.sent.length, phase === 'verification' ? 0 : 1);
      } finally {
        release();
        await running;
        await claim;
      }
    },
  );
}

void test('an authorization too short for the claim reserve is refused before a deposit', async (context) => {
  context.mock.method(Date, 'now', () => CLAIM_NOW);
  const value = await flow(context);
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
  const value = await flow(context);
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
