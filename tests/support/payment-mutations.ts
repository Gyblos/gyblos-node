import assert from 'node:assert/strict';

import { verifyZeroChargeReconciliation } from '@gyblos/cli/p2p/reconciliation';
import { DEVNET_TREASURY_OWNER } from '@gyblos/config';
import { tokenAddress } from '@gyblos/gate/chain';

import {
  accountIndex,
  accountInstruction,
  instructions,
  withOfflineProof,
  type PaymentFixture,
} from './payment-fixture.js';

export function tokenBalance(
  fixture: PaymentFixture,
  account: string,
  after: boolean,
  deposit = false,
) {
  const transaction = deposit ? fixture.source.deposit : fixture.source.claim;
  const rows = after
    ? transaction.meta.postTokenBalances
    : transaction.meta.preTokenBalances;
  const balance = rows.find(
    (row) => row.accountIndex === accountIndex(transaction, account),
  );
  assert.ok(balance, 'Required fixture token balance missing.');
  return balance;
}

export function tokenLeg(fixture: PaymentFixture, destination: string) {
  const leg = instructions(fixture.source.claim).find(
    (instruction) =>
      instruction.parsed?.type === 'transferChecked' &&
      instruction.parsed.info.destination === destination,
  );
  assert.ok(leg?.parsed);
  return leg.parsed;
}

export function shiftTokenBalance(
  fixture: PaymentFixture,
  account: string,
  amount: bigint,
  after: boolean,
  deposit = false,
) {
  const balance = tokenBalance(fixture, account, after, deposit);
  balance.uiTokenAmount.amount = (
    BigInt(balance.uiTokenAmount.amount) + amount
  ).toString();
}

export async function paymentAccounts(fixture: PaymentFixture) {
  return {
    buyerAta: await tokenAddress(fixture.expected.buyer, fixture.expected.mint),
    sellerAta: await tokenAddress(
      fixture.expected.payTo,
      fixture.expected.mint,
    ),
    treasuryAta: await tokenAddress(
      DEVNET_TREASURY_OWNER,
      fixture.expected.mint,
    ),
  };
}

export async function fullPrincipalRefund(fixture: PaymentFixture) {
  const { buyerAta, sellerAta } = await paymentAccounts(fixture);
  const charge = BigInt(tokenLeg(fixture, sellerAta).info.tokenAmount.amount);
  shiftTokenBalance(fixture, sellerAta, -charge, true);
  shiftTokenBalance(fixture, buyerAta, charge, true);
  tokenLeg(fixture, sellerAta).info.tokenAmount.amount = '0';
  tokenLeg(fixture, buyerAta).info.tokenAmount.amount =
    fixture.expected.ceiling;
  fixture.data.writeBigUInt64LE(0n, 20);
  fixture.data.writeBigUInt64LE(0n, 28);
}

export async function tokenCredit(fixture: PaymentFixture, amount: bigint) {
  const { sellerAta, treasuryAta } = await paymentAccounts(fixture);
  shiftTokenBalance(fixture, fixture.escrow, amount, false);
  shiftTokenBalance(fixture, treasuryAta, amount, true);
  const sweep = structuredClone(tokenLeg(fixture, sellerAta));
  sweep.info.destination = treasuryAta;
  sweep.info.tokenAmount.amount = amount.toString();
  const batch = instructions(fixture.source.claim).find(
    (instruction) => instruction.parsed?.type === 'batch',
  )?.parsed;
  assert.ok(batch);
  const closeIndex = batch.info.instructions.findIndex(
    (instruction) => instruction.type === 'closeAccount',
  );
  batch.info.instructions.splice(
    closeIndex < 0 ? batch.info.instructions.length : closeIndex,
    0,
    sweep,
  );
  return sweep;
}

export function lamportCredits(
  fixture: PaymentFixture,
  credits: { escrow?: number; interval?: number; later?: number },
) {
  const claim = fixture.source.claim;
  claim.meta.preBalances[accountIndex(claim, fixture.escrow)]! +=
    credits.escrow ?? 0;
  claim.meta.postBalances[accountIndex(claim, fixture.expected.feePayer)]! +=
    credits.escrow ?? 0;
  claim.meta.preBalances[accountIndex(claim, fixture.expected.channelId)]! +=
    credits.interval ?? 0;
  claim.meta.postBalances[accountIndex(claim, fixture.expected.channelId)]! +=
    credits.interval ?? 0;
  fixture.rent += (credits.interval ?? 0) + (credits.later ?? 0);
}

export function rentInfo(
  fixture: PaymentFixture,
  deposit: boolean,
  type: string,
): Record<string, unknown> {
  const info: unknown = accountInstruction(fixture, deposit, type).parsed!.info;
  assert.ok(typeof info === 'object' && info !== null && !Array.isArray(info));
  return info as Record<string, unknown>;
}

export function reconcileZeroCharge(fixture: PaymentFixture) {
  return withOfflineProof(fixture, () =>
    verifyZeroChargeReconciliation(
      fixture.expected,
      {
        channelId: fixture.expected.channelId,
        ceilingAtomic: fixture.expected.ceiling,
      },
      {
        channelId: fixture.expected.channelId,
        ceilingAtomic: fixture.expected.ceiling,
        depositSignature: fixture.expected.depositSignature,
        claimSignature: fixture.expected.claimSignature,
      },
    ),
  );
}
