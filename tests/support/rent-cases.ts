// Registers rent accounting cases: escrow creation and return in sponsor accounting, unsigned lamport
// credits, and each RENT_FAULTS mutation rejected by its guard.
import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyEscrowRent } from '@gyblos/payments-x402/accounting/escrow-rent';

import {
  guardFailure,
  paymentFixture,
  verifyPayment,
} from './payment-fixture.js';
import { lamportCredits } from './payment-mutations.js';
import { RENT_FAULTS } from './rent-faults.js';

export function registerRentCases() {
  void test('real-pair sponsor accounting includes escrow creation and return in each transaction', async () => {
    const fixture = await paymentFixture();
    const rent = verifyEscrowRent(
      fixture.source.deposit,
      fixture.source.claim,
      {
        escrowAta: fixture.escrow,
        channelId: fixture.expected.channelId,
        feePayer: fixture.expected.feePayer,
      },
    );
    const proof = await verifyPayment(fixture);
    assert.equal(rent.beforeDeposit, 0n);
    assert.equal(rent.afterClaim, 0n);
    assert.ok(rent.afterDeposit > 0n);
    assert.equal(rent.afterDeposit, rent.beforeClaim);
    assert.equal(
      BigInt(proof.sponsorDepositDeltaLamports),
      -BigInt(fixture.source.deposit.meta.fee) -
        BigInt(proof.retainedChannelRentLamports) -
        rent.afterDeposit,
    );
    assert.equal(
      BigInt(proof.sponsorClaimDeltaLamports),
      -BigInt(fixture.source.claim.meta.fee) + rent.beforeClaim,
    );
    assert.equal(
      BigInt(proof.sponsorTransactionDeltaLamports),
      -BigInt(proof.sponsorFeesLamports) -
        BigInt(proof.retainedChannelRentLamports),
    );
  });
  for (const credits of [
    { escrow: 1 },
    { interval: 1 },
    { later: 1 },
    { escrow: 7, interval: 11, later: 13 },
  ]) {
    void test(
      'unsigned positive lamport observations remain separate: ' +
        JSON.stringify(credits),
      async () => {
        const fixture = await paymentFixture();
        lamportCredits(fixture, credits);
        const proof = await verifyPayment(fixture);
        assert.equal(
          proof.escrowInterveningCreditLamports,
          String(credits.escrow ?? 0),
        );
        assert.equal(
          proof.channelInterveningCreditLamports,
          String(credits.interval ?? 0),
        );
        assert.equal(
          proof.channelPostClaimCreditLamports,
          String(credits.later ?? 0),
        );
        assert.equal(
          proof.chargedAtomic,
          fixture.historicalResult.chargedAtomic,
        );
        assert.equal(
          proof.sponsorFeesLamports,
          String(
            fixture.source.deposit.meta.fee + fixture.source.claim.meta.fee,
          ),
        );
      },
    );
  }
  for (const [name, [message, mutate]] of Object.entries(RENT_FAULTS))
    void test('finalized rent/proof rejects ' + name, async () => {
      const fixture = await paymentFixture();
      mutate(fixture);
      await assert.rejects(verifyPayment(fixture), guardFailure(message));
    });
}
