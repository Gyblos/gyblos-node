import assert from 'node:assert/strict';
import test from 'node:test';

import { RECONCILED_ZERO_CHARGE } from '@gyblos/cli/p2p/constants';
import { DEVNET_TREASURY_OWNER } from '@gyblos/config';

import {
  instructions,
  paymentFixture,
  verifyPayment,
  type PaymentFixture,
} from './payment-fixture.js';
import {
  fullPrincipalRefund,
  lamportCredits,
  paymentAccounts,
  reconcileZeroCharge,
  shiftTokenBalance,
  tokenBalance,
  tokenCredit,
  tokenLeg,
} from './payment-mutations.js';

type Accounts = Awaited<ReturnType<typeof paymentAccounts>>;
type Sweep = Awaited<ReturnType<typeof tokenCredit>>;
type Fault = (
  fixture: PaymentFixture,
  accounts: Accounts,
  sweep: Sweep,
) => void;

export function registerTokenCases() {
  test('saved real finalized pair retains original charge, refund and zero surplus', async () => {
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
      test(
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
  test('zero-charge recovery keeps principal refund separate from token and lamport credits', async () => {
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
  test('charged canonical settlement refuses zero-charge recovery despite a surplus', async () => {
    const fixture = await paymentFixture();
    await tokenCredit(fixture, 1n);
    await assert.rejects(
      reconcileZeroCharge(fixture),
      /confirmed charge requires charged-outcome recovery/,
    );
  });
  const faults: Record<string, Fault> = {
    'wrong treasury recipient': (f, _a, sweep) => {
      sweep.info.destination = f.expected.authorizer;
    },
    'wrong treasury owner': (f, a) => {
      tokenBalance(f, a.treasuryAta, true).owner = f.expected.buyer;
    },
    'wrong treasury mint': (f, a) => {
      tokenBalance(f, a.treasuryAta, true).mint = f.expected.authorizer;
    },
    'wrong escrow owner': (f) => {
      tokenBalance(f, f.escrow, false).owner = f.expected.buyer;
    },
    'wrong escrow mint': (f) => {
      tokenBalance(f, f.escrow, false).mint = f.expected.authorizer;
    },
    'wrong transfer mint': (f, _a, sweep) => {
      sweep.info.mint = f.expected.authorizer;
    },
    'short treasury sweep': (_f, _a, sweep) => {
      sweep.info.tokenAmount.amount = '0';
    },
    'excess treasury sweep': (_f, _a, sweep) => {
      sweep.info.tokenAmount.amount = '2';
    },
    'wrong treasury balance delta': (f, a) => {
      shiftTokenBalance(f, a.treasuryAta, 1n, true);
    },
    'wrong buyer refund delta': (f, a) => {
      shiftTokenBalance(f, a.buyerAta, 1n, true);
    },
    'wrong seller charge delta': (f, a) => {
      shiftTokenBalance(f, a.sellerAta, 1n, true);
    },
    'principal loss': (f, a) => {
      const leg = tokenLeg(f, a.buyerAta);
      leg.info.tokenAmount.amount = (
        BigInt(leg.info.tokenAmount.amount) - 1n
      ).toString();
    },
    'surplus disguised as refund': (f, a, sweep) => {
      tokenLeg(f, a.buyerAta).info.tokenAmount.amount = (
        BigInt(tokenLeg(f, a.buyerAta).info.tokenAmount.amount) + 1n
      ).toString();
      sweep.info.tokenAmount.amount = '0';
    },
    'surplus disguised as charge': (f, a, sweep) => {
      tokenLeg(f, a.sellerAta).info.tokenAmount.amount = (
        BigInt(tokenLeg(f, a.sellerAta).info.tokenAmount.amount) + 1n
      ).toString();
      sweep.info.tokenAmount.amount = '0';
    },
    'prefunded escrow': (f) => {
      shiftTokenBalance(f, f.escrow, 1n, false, true);
    },
    'principal decreased before claim': (f) => {
      shiftTokenBalance(f, f.escrow, -2n, false);
    },
    'nonempty final escrow': (f) => {
      const row = structuredClone(tokenBalance(f, f.escrow, false));
      row.uiTokenAmount.amount = '1';
      f.source.claim.meta.postTokenBalances.push(row);
    },
    'duplicate balance row': (f, a) => {
      f.source.claim.meta.postTokenBalances.push(
        structuredClone(tokenBalance(f, a.treasuryAta, true)),
      );
    },
    'duplicate account key': (f, a) => {
      const key = f.source.claim.transaction.message.accountKeys.find(
        (key) => key.pubkey === a.treasuryAta,
      );
      assert.ok(key);
      f.source.claim.transaction.message.accountKeys.push(structuredClone(key));
    },
    'canonical settlement differs': (f) => {
      f.data.writeBigUInt64LE(0n, 20);
    },
    'seller aliases treasury': (f) => {
      f.expected.payTo = DEVNET_TREASURY_OWNER;
    },
    'negative token balance': (f) => {
      tokenBalance(f, f.escrow, false).uiTokenAmount.amount = '-1';
    },
    'claim-time incoming tokens': (f, a, sweep) => {
      sweep.info.source = a.buyerAta;
      sweep.info.destination = f.escrow;
    },
    'deposit from a third party': (f) => {
      const leg = instructions(f.source.deposit).find(
        (ix) => ix.parsed?.type === 'transferChecked',
      );
      assert.ok(leg?.parsed);
      leg.parsed.info.source = f.expected.authorizer;
    },
  };
  for (const [name, mutate] of Object.entries(faults))
    test('token proof rejects ' + name, async () => {
      const fixture = await paymentFixture();
      const accounts = await paymentAccounts(fixture);
      const sweep = await tokenCredit(fixture, 1n);
      mutate(fixture, accounts, sweep);
      await assert.rejects(verifyPayment(fixture));
    });
}
