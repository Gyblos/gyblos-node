// Seller half of the payment port contract: what PaymentServer admits, deposits and settles.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import type {
  PaymentAuthorization,
  PaymentTerms,
} from '@gyblos/protocol/payment';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import {
  admitted,
  assertPublic,
  CONTRACT_CEILING,
  count,
  delta,
  otherDigest,
  PAYMENT_EVENTS,
  rejectsWith,
  SELLER_KEYS,
  withRig,
  type PaymentHarness,
} from './payment-rig';

function forged(authorization: PaymentAuthorization): PaymentAuthorization[] {
  return [
    { ...authorization, payer: `${authorization.payer}x` },
    { ...authorization, maxAtomic: String(CONTRACT_CEILING - 1n) },
    {
      ...authorization,
      requestDigest: otherDigest(authorization.requestDigest),
    },
    { ...authorization, channelId: otherDigest(authorization.channelId) },
    { ...authorization, payload: `${authorization.payload}x` },
  ];
}

// Terms the seller never issued for this authorization; each differs in one money-binding field.
function foreignTerms(terms: PaymentTerms): Partial<PaymentTerms>[] {
  return [
    { maxAtomic: String(CONTRACT_CEILING - 1n) },
    { requestDigest: otherDigest(terms.requestDigest) },
    { buyer: terms.payTo },
    { payTo: terms.buyer },
    { feePayer: terms.buyer },
    { authorizer: terms.buyer },
    { network: 'solana:other' },
    { mint: terms.payTo },
    { expiresAt: terms.expiresAt + 1 },
    { protocolFeeBps: terms.protocolFeeBps + 1 },
    { treasury: terms.buyer },
  ];
}

function admissionContract(name: string, harness: PaymentHarness): void {
  void test(`${name}: admission rejects any mismatch without moving funds`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const authorization = await rig.client.authorize(terms);
      const before = rig.observe().balances;
      for (const authorizationForged of forged(authorization))
        await rejectsWith(
          rig.server.admit(authorizationForged, terms),
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        );
      for (const overrides of foreignTerms(terms))
        await rejectsWith(
          rig.server.admit(authorization, { ...terms, ...overrides }),
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        );
      assert.deepEqual(rig.observe().balances, before);
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
    }));

  void test(`${name}: another seller cannot admit an authorization made for this one`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const authorization = await rig.client.authorize(terms);
      for (const field of SELLER_KEYS) {
        const other = await rig.serverWith(field);
        await rejectsWith(
          other.admit(authorization, { ...terms, ...(await other.describe()) }),
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        );
      }
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
    }));

  void test(`${name}: only the distribution the terms prescribe is admitted`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const [seller, fee] = paymentSplits(terms);
      assert.ok(seller && fee);
      for (const splits of [
        [{ recipient: terms.payTo, bps: 10_000 }],
        [seller, { recipient: terms.buyer, bps: fee.bps }],
        [
          { recipient: terms.payTo, bps: seller.bps + 1 },
          { recipient: terms.treasury, bps: fee.bps - 1 },
        ],
        [fee, seller],
      ])
        await rejectsWith(
          rig.server.admit(
            await rig.authorizationWithSplits(terms, splits),
            terms,
          ),
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        );
      const signed = await rig.client.authorize(terms);
      await rejectsWith(
        rig.server.admit(
          await rig.tamperSplits(signed, [
            { recipient: terms.payTo, bps: 10_000 },
          ]),
          terms,
        ),
        PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      );
      // A buyer that signs no fee but presents the prescribed distribution afterwards.
      await rejectsWith(
        rig.server.admit(
          await rig.tamperSplits(
            await rig.authorizationWithSplits(terms, [
              { recipient: terms.payTo, bps: 10_000 },
            ]),
            paymentSplits(terms),
          ),
          terms,
        ),
        PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      );
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
      // The hook itself is sound: the prescribed distribution is admitted.
      assert.ok(
        await rig.server.admit(
          await rig.authorizationWithSplits(terms, paymentSplits(terms)),
          terms,
        ),
      );
    }));

  void test(`${name}: only the offer's buyer can deposit for it`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      await rejectsWith(
        rig.server.admit(await rig.foreignAuthorization(terms), terms),
        PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      );
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
    }));

  void test(`${name}: the signature binds the deposited ceiling`, async () =>
    withRig(harness, async (rig) => {
      const signed = await rig.terms({
        maxAtomic: String(CONTRACT_CEILING - 1n),
      });
      const authorization = await rig.client.authorize(signed);
      const ceiling = String(CONTRACT_CEILING);
      await rejectsWith(
        rig.server.admit(
          { ...authorization, maxAtomic: ceiling },
          { ...signed, maxAtomic: ceiling },
        ),
        PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      );
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
    }));

  void test(`${name}: terms that expire before admission are refused without a deposit`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms({ expiresAt: rig.now() + 1_000 });
      const authorization = await rig.client.authorize(terms);
      rig.advance(1_000);
      await rejectsWith(
        rig.server.admit(authorization, terms),
        PAYMENT_ERROR_CODES.TERMS_EXPIRED,
      );
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
    }));

  void test(`${name}: an aborted admission rejects with the caller's reason and deposits nothing`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const authorization = await rig.client.authorize(terms);
      const reason = new Error('caller cancelled');
      await assert.rejects(
        rig.server.admit(authorization, terms, {
          signal: AbortSignal.abort(reason),
        }),
        (error: unknown) => error === reason,
      );
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
      assert.ok(await rig.server.admit(authorization, terms));
    }));

  void test(`${name}: an abort after the deposit is sent does not interrupt admission`, async () => {
    const lateAbort = new AbortController();
    await withRig(
      harness,
      async (rig) => {
        const terms = await rig.terms();
        const authorization = await rig.client.authorize(terms);
        const admission = await rig.server.admit(authorization, terms, {
          signal: lateAbort.signal,
        });
        assert.ok(lateAbort.signal.aborted);
        assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 1);
        assert.equal(
          (await rig.server.settle(admission, '0')).channelId,
          authorization.channelId,
        );
      },
      { onDepositSent: () => lateAbort.abort(new Error('too late')) },
    );
  });

  void test(`${name}: an open channel stays reused after its terms expire`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms({ expiresAt: rig.now() + 1_000 });
      const authorization = await rig.client.authorize(terms);
      await rig.server.admit(authorization, terms);
      rig.advance(1_000);
      await rejectsWith(
        rig.server.admit(authorization, terms),
        PAYMENT_ERROR_CODES.CHANNEL_REUSED,
      );
    }));

  void test(`${name}: a forged authorization for an open channel is a mismatch, not a reuse`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const authorization = await rig.client.authorize(terms);
      await rig.server.admit(authorization, terms);
      await rejectsWith(
        rig.server.admit(
          { ...authorization, payload: `${authorization.payload}x` },
          terms,
        ),
        PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      );
    }));

  void test(`${name}: an authorization cannot be stretched to another expiry`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms({ expiresAt: rig.now() + 1 });
      const authorization = await rig.client.authorize(terms);
      await rejectsWith(
        rig.server.admit(authorization, { ...terms, expiresAt: rig.now() }),
        PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      );
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
    }));

  void test(`${name}: a channel is admitted once, even concurrently, and deposits the ceiling`, async () =>
    withRig(harness, async (rig) => {
      const before = rig.observe().balances;
      const terms = await rig.terms();
      const authorization = await rig.client.authorize(terms);
      const results = await Promise.allSettled([
        rig.server.admit(authorization, terms),
        rig.server.admit(authorization, terms),
      ]);
      const admission = results.find((result) => result.status === 'fulfilled');
      assert.equal(admission?.value.channelId, authorization.channelId);
      assert.equal(admission.value.maxAtomic, terms.maxAtomic);
      assertPublic(admission.value);
      const rejected = results.find((result) => result.status === 'rejected');
      await rejectsWith(
        Promise.reject(rejected?.reason),
        PAYMENT_ERROR_CODES.CHANNEL_REUSED,
      );
      assert.deepEqual(delta(before, rig.observe().balances), {
        payer: -CONTRACT_CEILING,
        payee: 0n,
        treasury: 0n,
        escrow: CONTRACT_CEILING,
      });
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 1);
    }));

  void test(`${name}: upstream failures surface as unavailable without leaking`, async () =>
    withRig(
      harness,
      async (rig) => {
        const terms = await rig.terms();
        const authorization = await rig.client.authorize(terms);
        await rejectsWith(
          rig.server.admit(authorization, terms),
          PAYMENT_ERROR_CODES.UNAVAILABLE,
        );
        assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
      },
      { failUpstream: true },
    ));
}

export function paymentServerContract(
  name: string,
  harness: PaymentHarness,
): void {
  admissionContract(name, harness);
}
