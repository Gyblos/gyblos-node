import assert from 'node:assert/strict';
import test from 'node:test';

import { CHANNEL_PROGRAM, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import { verifyEscrowRent } from '@gyblos/gate/escrow-rent';

import {
  accountIndex,
  accountInstruction,
  paymentFixture,
  verifyPayment,
  type PaymentFixture,
} from './payment-fixture.js';
import { lamportCredits, rentInfo } from './payment-mutations.js';

type Fault = (fixture: PaymentFixture) => void;

export function registerRentCases() {
  test('real-pair sponsor accounting includes escrow creation and return in each transaction', async () => {
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
    test(
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
  const faults: Record<string, Fault> = {
    'wrong escrow rent payer': (f) => {
      rentInfo(f, true, 'createAccount').source = f.expected.buyer;
    },
    'wrong escrow account owner': (f) => {
      rentInfo(f, true, 'createAccount').owner = f.expected.authorizer;
    },
    'wrong escrow account size': (f) => {
      rentInfo(f, true, 'createAccount').space = 1;
    },
    'wrong escrow rent amount': (f) => {
      const info = rentInfo(f, true, 'createAccount');
      info.lamports = Number(info.lamports) + 1;
    },
    'wrong escrow create program': (f) => {
      accountInstruction(f, true, 'createAccount').programId = CHANNEL_PROGRAM;
    },
    'missing escrow creation': (f) => {
      accountInstruction(f, true, 'createAccount').parsed!.type = 'omitted';
    },
    'duplicate escrow creation': (f) => {
      f.source.deposit.transaction.message.instructions.push(
        structuredClone(accountInstruction(f, true, 'createAccount')),
      );
    },
    'wrong escrow close recipient': (f) => {
      rentInfo(f, false, 'closeAccount').destination = f.expected.buyer;
    },
    'wrong escrow close authority': (f) => {
      rentInfo(f, false, 'closeAccount').owner = f.expected.buyer;
    },
    'missing escrow close': (f) => {
      f.source.claim.transaction.message.instructions =
        f.source.claim.transaction.message.instructions.filter(
          (instruction) => instruction.parsed?.type !== 'closeAccount',
        );
      for (const group of f.source.claim.meta.innerInstructions ?? [])
        group.instructions = group.instructions.filter(
          (instruction) => instruction.parsed?.type !== 'closeAccount',
        );
    },
    'duplicate escrow close': (f) => {
      f.source.claim.transaction.message.instructions.push(
        structuredClone(accountInstruction(f, false, 'closeAccount')),
      );
    },
    'prefunded escrow rent': (f) => {
      f.source.deposit.meta.preBalances[
        accountIndex(f.source.deposit, f.escrow)
      ] = 1;
    },
    'decreased escrow rent': (f) => {
      f.source.claim.meta.preBalances[
        accountIndex(f.source.claim, f.escrow)
      ]! -= 1;
    },
    'unclosed escrow rent': (f) => {
      f.source.claim.meta.postBalances[accountIndex(f.source.claim, f.escrow)] =
        1;
    },
    'unsafe rent amount': (f) => {
      f.source.deposit.meta.postBalances[
        accountIndex(f.source.deposit, f.escrow)
      ] = Number.MAX_SAFE_INTEGER + 1;
    },
    'offsetting sponsor errors': (f) => {
      f.source.deposit.meta.postBalances[0]! += 1;
      f.source.claim.meta.postBalances[0]! -= 1;
    },
    'shifted fees': (f) => {
      f.source.deposit.meta.fee += 1;
      f.source.claim.meta.fee -= 1;
    },
    'buyer SOL charge': (f) => {
      f.source.deposit.meta.postBalances[
        accountIndex(f.source.deposit, f.expected.buyer)
      ]! += 1;
    },
    'channel interval depletion': (f) => {
      lamportCredits(f, { interval: -1 });
    },
    'channel later depletion': (f) => {
      lamportCredits(f, { later: -1 });
    },
    'wrong channel owner': (f) => {
      f.owner = TOKEN_PROGRAM_ADDRESS;
    },
    'wrong canonical PDA': (f) => {
      f.data.writeBigUInt64LE(f.data.readBigUInt64LE(4) + 1n, 4);
    },
    'wrong channel state': (f) => {
      f.data[3] = 0;
    },
    'missing current channel': (f) => {
      f.accountMissing = true;
    },
    'initial rent below minimum': (f) => {
      f.minimum += 1;
    },
    'nonfinalized status': (f) => {
      f.confirmation = 'confirmed';
    },
    'missing finalized status': (f) => {
      f.confirmation = null;
    },
    'reused transaction signatures': (f) => {
      f.expected.claimSignature = f.expected.depositSignature;
    },
    'transaction error': (f) => {
      f.source.claim.meta.err = { custom: 1 };
    },
    'claim before deposit': (f) => {
      f.source.claim.slot = f.source.deposit.slot - 1;
    },
    'wrong transaction signature': (f) => {
      f.source.claim.transaction.signatures[0] = f.expected.depositSignature;
    },
  };
  for (const [name, mutate] of Object.entries(faults))
    test('finalized rent/proof rejects ' + name, async () => {
      const fixture = await paymentFixture();
      mutate(fixture);
      if (name === 'missing escrow close')
        await assert.rejects(
          verifyPayment(fixture),
          /One canonical escrow closure is required/,
        );
      else await assert.rejects(verifyPayment(fixture));
    });
}
