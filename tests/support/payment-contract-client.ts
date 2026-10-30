// Buyer half of the payment port contract: what PaymentClient signs, journals and accepts.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import type { PaymentTerms } from '@gyblos/protocol/payment';

import {
  admitted,
  assertPublic,
  CONTRACT_CEILING,
  CONTRACT_PARTIAL,
  count,
  PAYMENT_EVENTS,
  rejectsWith,
  withRig,
  type PaymentHarness,
  type PaymentRig,
} from './payment-rig';

async function hostileTerms(rig: PaymentRig): Promise<Partial<PaymentTerms>[]> {
  const valid = await rig.terms();
  return [
    { network: 'solana:other' },
    { mint: valid.payTo },
    { buyer: valid.payTo },
    { maxAtomic: String(CONTRACT_CEILING + 1n) },
    { maxAtomic: '0' },
    { maxAtomic: '-1' },
    { maxAtomic: '01' },
    { maxAtomic: 'one' },
    { requestDigest: 'not-a-digest' },
    { expiresAt: rig.now() },
    { protocolFeeBps: valid.protocolFeeBps + 1 },
    { treasury: valid.payTo },
  ];
}

function authorizationContract(name: string, harness: PaymentHarness): void {
  void test(`${name}: untrusted terms are rejected before any journal or signature`, async () =>
    withRig(harness, async (rig) => {
      for (const overrides of await hostileTerms(rig))
        await rejectsWith(
          rig.client.authorize(await rig.terms(overrides)),
          PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
        );
      assert.deepEqual(rig.observe().events, []);
    }));

  void test(`${name}: the journal is written before the only signature`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const authorization = await rig.client.authorize(terms);
      assert.deepEqual(rig.observe().events, [
        PAYMENT_EVENTS.JOURNAL,
        PAYMENT_EVENTS.SIGN,
      ]);
      assert.equal(authorization.requestDigest, terms.requestDigest);
      assert.equal(authorization.maxAtomic, terms.maxAtomic);
      assert.equal(authorization.payer, terms.buyer);
      assertPublic(authorization);
    }));

  void test(`${name}: terms that expired on the buyer's clock are never signed`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms({ expiresAt: rig.now() + 1_000 });
      rig.advance(1_000);
      await rejectsWith(
        rig.client.authorize(terms),
        PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
      );
      assert.deepEqual(rig.observe().events, []);
    }));

  void test(`${name}: an unavailable journal prevents signing`, async () =>
    withRig(
      harness,
      async (rig) => {
        await rejectsWith(
          rig.client.authorize(await rig.terms()),
          PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
        );
        assert.equal(count(rig, PAYMENT_EVENTS.SIGN), 0);
      },
      { failJournal: true },
    ));

  void test(`${name}: concurrent authorizations of one request sign once`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const results = await Promise.allSettled([
        rig.client.authorize(terms),
        rig.client.authorize(terms),
      ]);
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const rejected = results.find((result) => result.status === 'rejected');
      await rejectsWith(
        Promise.reject(rejected?.reason),
        PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED,
      );
      // Still journaled before the one signature, whichever call won.
      assert.deepEqual(rig.observe().events, [
        PAYMENT_EVENTS.JOURNAL,
        PAYMENT_EVENTS.SIGN,
      ]);
    }));

  void test(`${name}: a lost authorization is never signed again and stays open for reconciliation`, async () =>
    withRig(harness, async (rig) => {
      const terms = await rig.terms();
      const lost = await rig.client.authorize(terms);
      await rejectsWith(
        rig.client.authorize(terms),
        PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED,
      );
      assert.equal(count(rig, PAYMENT_EVENTS.SIGN), 1);
      const reconciled = await rig.client.reconcile();
      assert.deepEqual(reconciled, [
        {
          channelId: lost.channelId,
          requestDigest: terms.requestDigest,
          state: PAYMENT_CHANNEL_STATES.OPEN,
          chargedAtomic: null,
        },
      ]);
      assertPublic(reconciled);
    }));
}

function receiptContract(name: string, harness: PaymentHarness): void {
  void test(`${name}: the buyer accepts only settlements the ledger confirms at its own metering`, async () =>
    withRig(harness, async (rig) => {
      const { authorization, admission } = await admitted(rig);
      const settlement = await rig.server.settle(
        admission,
        String(CONTRACT_PARTIAL),
      );
      const lower = String(CONTRACT_PARTIAL - 1n);
      for (const [received, expected] of [
        [settlement, lower],
        // A seller that settled CONTRACT_PARTIAL on chain but reports less.
        [
          {
            ...settlement,
            chargedAtomic: lower,
            refundedAtomic: String(CONTRACT_CEILING - CONTRACT_PARTIAL + 1n),
          },
          lower,
        ],
        // Reports a lower charge but the true refund; only the ledger shows the difference.
        [{ ...settlement, chargedAtomic: lower }, lower],
        [{ ...settlement, refundedAtomic: '0' }, String(CONTRACT_PARTIAL)],
        // Claims the fee was smaller (or the seller's share larger) than the ledger paid.
        [{ ...settlement, feeAtomic: '0' }, String(CONTRACT_PARTIAL)],
        [
          {
            ...settlement,
            sellerAtomic: String(BigInt(settlement.sellerAtomic) + 1n),
          },
          String(CONTRACT_PARTIAL),
        ],
        [{ ...settlement, transaction: '' }, String(CONTRACT_PARTIAL)],
        [
          { ...settlement, channelId: `${settlement.channelId}x` },
          String(CONTRACT_PARTIAL),
        ],
      ] as const)
        await rejectsWith(
          rig.client.checkReceipt(authorization, received, expected),
          PAYMENT_ERROR_CODES.RECEIPT_MISMATCH,
        );
      assert.equal(
        (await rig.client.reconcile())[0]?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
      await rig.client.checkReceipt(
        authorization,
        settlement,
        String(CONTRACT_PARTIAL),
      );
      await rejectsWith(
        rig.client.checkReceipt(
          authorization,
          settlement,
          String(CONTRACT_PARTIAL),
        ),
        PAYMENT_ERROR_CODES.ALREADY_SETTLED,
      );
    }));

  void test(`${name}: a real settlement of another channel is not a receipt for this one`, async () =>
    withRig(harness, async (rig) => {
      const { authorization } = await admitted(rig);
      const terms = await rig.terms({ requestDigest: 'a'.repeat(64) });
      const other = await rig.server.admit(
        await rig.client.authorize(terms),
        terms,
      );
      const otherSettlement = await rig.server.settle(other, '0');
      await rejectsWith(
        rig.client.checkReceipt(
          authorization,
          { ...otherSettlement, channelId: authorization.channelId },
          '0',
        ),
        PAYMENT_ERROR_CODES.RECEIPT_MISMATCH,
      );
    }));

  void test(`${name}: a receipt for an authorization the buyer never made is rejected`, async () =>
    withRig(harness, async (rig) => {
      const { authorization, admission } = await admitted(rig);
      const settlement = await rig.server.settle(admission, '0');
      await rejectsWith(
        rig.client.checkReceipt(
          { ...authorization, requestDigest: '0'.repeat(64) },
          settlement,
          '0',
        ),
        PAYMENT_ERROR_CODES.RECEIPT_MISMATCH,
      );
    }));
}

export function paymentClientContract(
  name: string,
  harness: PaymentHarness,
): void {
  authorizationContract(name, harness);
  receiptContract(name, harness);
}
