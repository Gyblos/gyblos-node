// Seller half of the payment port contract: what PaymentServer admits, deposits and settles.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import type {
  PaymentAuthorization,
  PaymentTerms,
} from '@gyblos/protocol/payment';

import {
  admitted,
  assertPublic,
  CONTRACT_CEILING,
  CONTRACT_NOW,
  CONTRACT_PARTIAL,
  count,
  delta,
  otherDigest,
  PAYMENT_EVENTS,
  rejectsWith,
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
      for (const overrides of [
        { payTo: 'payee-other' },
        { feePayer: 'fee-payer-other' },
        { authorizer: 'authorizer-other' },
      ]) {
        const other = rig.serverWith(overrides);
        await rejectsWith(
          other.admit(authorization, { ...terms, ...(await other.describe()) }),
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        );
      }
      assert.equal(count(rig, PAYMENT_EVENTS.DEPOSIT), 0);
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

  void test(`${name}: expired terms are not admitted`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms({ expiresAt: CONTRACT_NOW + 1 });
      const authorization = await rig.client.authorize(terms);
      await rejectsWith(
        rig.server.admit(authorization, { ...terms, expiresAt: CONTRACT_NOW }),
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

function settlementContract(name: string, harness: PaymentHarness): void {
  for (const charged of [0n, CONTRACT_PARTIAL, CONTRACT_CEILING])
    void test(`${name}: settling ${charged} charges it and refunds the rest`, async () =>
      withRig(harness, async (rig) => {
        const before = rig.observe().balances;
        const { authorization, admission } = await admitted(rig);
        const settlement = await rig.server.settle(admission, String(charged));
        assert.equal(settlement.channelId, admission.channelId);
        assert.equal(settlement.chargedAtomic, String(charged));
        assert.equal(
          settlement.refundedAtomic,
          String(CONTRACT_CEILING - charged),
        );
        assert.ok(settlement.transaction.length > 0);
        assertPublic(settlement);
        assert.deepEqual(delta(before, rig.observe().balances), {
          payer: -charged,
          payee: charged,
          escrow: 0n,
        });
        assert.deepEqual(rig.observe().events, [
          PAYMENT_EVENTS.JOURNAL,
          PAYMENT_EVENTS.SIGN,
          PAYMENT_EVENTS.DEPOSIT,
          PAYMENT_EVENTS.SETTLE,
        ]);
        await rig.client.checkReceipt(
          authorization,
          settlement,
          String(charged),
        );
        assert.deepEqual(await rig.client.reconcile(), [
          {
            channelId: authorization.channelId,
            requestDigest: authorization.requestDigest,
            state: PAYMENT_CHANNEL_STATES.SETTLED,
            chargedAtomic: String(charged),
          },
        ]);
      }));

  void test(`${name}: settlement trusts only the server's own channel record`, async () =>
    withRig(harness, async (rig) => {
      const { admission } = await admitted(rig);
      const before = rig.observe().balances;
      const bigger = String(CONTRACT_CEILING * 2n);
      for (const [altered, charged, code] of [
        [
          { ...admission, maxAtomic: bigger },
          bigger,
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        ],
        [
          { ...admission, payer: `${admission.payer}x` },
          '1',
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        ],
        [
          { ...admission, requestDigest: otherDigest(admission.requestDigest) },
          '1',
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        ],
        [
          { ...admission, channelId: otherDigest(admission.channelId) },
          '1',
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        ],
        [
          admission,
          String(CONTRACT_CEILING + 1n),
          PAYMENT_ERROR_CODES.INVALID_CHARGE,
        ],
        [admission, '-1', PAYMENT_ERROR_CODES.INVALID_CHARGE],
        [admission, '1.5', PAYMENT_ERROR_CODES.INVALID_CHARGE],
        [admission, '', PAYMENT_ERROR_CODES.INVALID_CHARGE],
      ] as const)
        await rejectsWith(rig.server.settle(altered, charged), code);
      assert.deepEqual(rig.observe().balances, before);
    }));

  void test(`${name}: a repeated settlement returns the first and never charges twice`, async () =>
    withRig(harness, async (rig) => {
      const { admission } = await admitted(rig);
      const first = await rig.server.settle(
        admission,
        String(CONTRACT_PARTIAL),
      );
      const settled = rig.observe().balances;
      assert.deepEqual(
        await rig.server.settle(admission, String(CONTRACT_PARTIAL)),
        first,
      );
      await rejectsWith(
        rig.server.settle(admission, String(CONTRACT_PARTIAL + 1n)),
        PAYMENT_ERROR_CODES.ALREADY_SETTLED,
      );
      assert.deepEqual(rig.observe().balances, settled);
      assert.equal(count(rig, PAYMENT_EVENTS.SETTLE), 1);
    }));
}

export function paymentServerContract(
  name: string,
  harness: PaymentHarness,
): void {
  admissionContract(name, harness);
  settlementContract(name, harness);
}
