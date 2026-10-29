// Settlement half of the payment port contract: what PaymentServer charges, refunds and pays out.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { settlementShares } from '@gyblos/protocol/payment-binding';

import {
  admitted,
  assertPublic,
  CONTRACT_CEILING,
  CONTRACT_PARTIAL,
  count,
  delta,
  otherDigest,
  PAYMENT_EVENTS,
  rejectsWith,
  withRig,
  type PaymentHarness,
} from './payment-rig';

export function paymentSettlementContract(
  name: string,
  harness: PaymentHarness,
): void {
  for (const charged of [0n, CONTRACT_PARTIAL, CONTRACT_CEILING])
    void test(`${name}: settling ${charged} charges it and refunds the rest`, async () =>
      withRig(harness, async (rig) => {
        const before = rig.observe().balances;
        const { terms, authorization, admission } = await admitted(rig);
        const settlement = await rig.server.settle(admission, String(charged));
        assert.equal(settlement.channelId, admission.channelId);
        assert.equal(settlement.chargedAtomic, String(charged));
        assert.equal(
          settlement.refundedAtomic,
          String(CONTRACT_CEILING - charged),
        );
        assert.ok(settlement.transaction.length > 0);
        assertPublic(settlement);
        const shares = settlementShares(String(charged), terms.protocolFeeBps);
        assert.equal(settlement.sellerAtomic, shares.sellerAtomic);
        assert.equal(settlement.feeAtomic, shares.feeAtomic);
        const moved = delta(before, rig.observe().balances);
        assert.equal(moved.payer, -charged);
        assert.equal(moved.escrow, 0n);
        assert.equal(moved.payee, BigInt(shares.sellerAtomic));
        assert.equal(moved.treasury, BigInt(shares.feeAtomic));
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

  void test(`${name}: concurrent settlements with different charges settle once`, async () =>
    withRig(harness, async (rig) => {
      const { admission } = await admitted(rig);
      const before = rig.observe().balances;
      const results = await Promise.allSettled([
        rig.server.settle(admission, String(CONTRACT_PARTIAL)),
        rig.server.settle(admission, String(CONTRACT_PARTIAL + 1n)),
      ]);
      const settled = results.find((result) => result.status === 'fulfilled');
      const rejected = results.find((result) => result.status === 'rejected');
      await rejectsWith(
        Promise.reject(rejected?.reason),
        PAYMENT_ERROR_CODES.ALREADY_SETTLED,
      );
      const moved = delta(before, rig.observe().balances);
      assert.equal(moved.payee, BigInt(settled?.value.sellerAtomic ?? '-1'));
      assert.equal(moved.treasury, BigInt(settled?.value.feeAtomic ?? '-1'));
      assert.equal(count(rig, PAYMENT_EVENTS.SETTLE), 1);
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
