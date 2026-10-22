// Owns offline token cases regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RECONCILED_ZERO_CHARGE } from '@gyblos/buyer/constants';

import {
  guardFailure,
  paymentFixture,
  verifyPayment,
} from './payment-fixture.js';
import {
  fullPrincipalRefund,
  lamportCredits,
  paymentAccounts,
  reconcileZeroCharge,
  tokenCredit,
} from './payment-mutations.js';
import { TOKEN_FAULTS } from './token-faults.js';

export function registerTokenCases() {
  void test('saved real finalized pair retains original charge, refund and zero surplus', async () => {
    const fixture = await paymentFixture();
    const proof = await verifyPayment(fixture);
    assert.equal(proof.chargedAtomic, fixture.historicalResult.chargedAtomic);
    assert.equal(proof.refundAtomic, fixture.historicalResult.refundAtomic);
    assert.equal(proof.escrowInterveningTokenCreditAtomic, '0');
    assert.equal(proof.treasurySweepAtomic, '0');
    assert.ok(fixture.methods.every((method) => method.startsWith('get')));
  });
  for (const fullRefund of [false, true])
    for (const credit of [1n, 17n]) {
      void test(
        'unsigned token credit preserves principal: full refund=' +
          fullRefund +
          ', credit=' +
          credit,
        async () => {
          const fixture = await paymentFixture();
          if (fullRefund) await fullPrincipalRefund(fixture);
          await tokenCredit(fixture, credit);
          const proof = await verifyPayment(fixture);
          assert.equal(
            BigInt(proof.chargedAtomic) + BigInt(proof.refundAtomic),
            BigInt(fixture.expected.ceiling),
          );
          assert.equal(
            proof.chargedAtomic,
            fullRefund ? '0' : fixture.historicalResult.chargedAtomic,
          );
          assert.equal(
            proof.escrowInterveningTokenCreditAtomic,
            credit.toString(),
          );
          assert.equal(proof.treasurySweepAtomic, credit.toString());
          assert.equal(
            proof.escrowDepositAfterAtomic,
            fixture.expected.ceiling,
          );
          assert.equal(
            proof.escrowClaimBeforeAtomic,
            (BigInt(fixture.expected.ceiling) + credit).toString(),
          );
          assert.equal(proof.escrowClaimAfterAtomic, '0');
          assert.equal(
            proof.balanceDeltas.buyer,
            (-BigInt(proof.chargedAtomic)).toString(),
          );
          assert.equal(proof.balanceDeltas.seller, proof.chargedAtomic);
        },
      );
    }
  void test('zero-charge recovery keeps principal refund separate from token and lamport credits', async () => {
    const fixture = await paymentFixture();
    await fullPrincipalRefund(fixture);
    await tokenCredit(fixture, 17n);
    lamportCredits(fixture, { escrow: 7, interval: 11, later: 13 });
    const proof = await reconcileZeroCharge(fixture);
    assert.equal(proof.status, RECONCILED_ZERO_CHARGE);
    assert.equal(proof.chargedAtomic, '0');
    assert.equal(proof.refundAtomic, fixture.expected.ceiling);
    assert.equal(proof.treasurySweepAtomic, '17');
    assert.equal(proof.escrowInterveningCreditLamports, '7');
    assert.equal(proof.channelInterveningCreditLamports, '11');
    assert.equal(proof.channelPostClaimCreditLamports, '13');
  });
  void test('charged canonical settlement refuses zero-charge recovery despite a surplus', async () => {
    const fixture = await paymentFixture();
    await tokenCredit(fixture, 1n);
    await assert.rejects(
      reconcileZeroCharge(fixture),
      /confirmed charge requires charged-outcome recovery/,
    );
  });
  for (const [name, [message, mutate]] of Object.entries(TOKEN_FAULTS))
    void test('token proof rejects ' + name, async () => {
      const fixture = await paymentFixture();
      const accounts = await paymentAccounts(fixture);
      const sweep = await tokenCredit(fixture, 1n);
      mutate(fixture, accounts, sweep);
      await assert.rejects(verifyPayment(fixture), guardFailure(message));
    });
}
