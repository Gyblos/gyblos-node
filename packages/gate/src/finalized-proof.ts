import assert from 'node:assert/strict';

import { FINALIZED_COMMITMENT, SVM_TRANSACTION_VERSION } from '@gyblos/config';
import { verifyFinalizedChannel } from '@gyblos/payments-x402/finalized-channel';

import { readChain, tokenAddress } from './chain.js';
import {
  transactionLamports as lamports,
  verifyEscrowRent,
} from './escrow-rent.js';
import {
  verifyEscrowTokens,
  type EscrowTokenTransaction,
} from './escrow-tokens.js';

interface FinalizedTransaction extends EscrowTokenTransaction {
  meta: EscrowTokenTransaction['meta'] & {
    fee: number;
    preBalances: number[];
    postBalances: number[];
  };
}

export interface FinalizedPaymentExpectation {
  rpcUrl: string;
  buyer: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  mint: string;
  channelId: string;
  ceiling: string;
  depositSignature: string;
  claimSignature: string;
}

async function finalizedTransaction(
  expected: FinalizedPaymentExpectation,
  signature: string,
) {
  assert.ok(signature.length > 0);
  const transaction = await readChain<FinalizedTransaction | null>(
    expected,
    'getTransaction',
    [
      signature,
      {
        commitment: FINALIZED_COMMITMENT,
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: SVM_TRANSACTION_VERSION,
      },
    ],
  );
  assert.ok(transaction, 'Finalized transaction unavailable.');
  assert.equal(transaction.meta.err, null);
  assert.ok(Number.isSafeInteger(transaction.slot) && transaction.slot >= 0);
  assert.equal(transaction.transaction.signatures[0], signature);
  assert.equal(
    transaction.transaction.message.accountKeys[0]?.pubkey,
    expected.feePayer,
  );
  assert.ok(
    Number.isSafeInteger(transaction.meta.fee) && transaction.meta.fee >= 0,
  );
  return transaction;
}

export async function finalizedPaymentProof(
  expected: FinalizedPaymentExpectation,
) {
  assert.match(expected.ceiling, /^\d+$/);
  const ceiling = BigInt(expected.ceiling);
  assert.ok(ceiling > 0n);
  assert.notEqual(expected.depositSignature, expected.claimSignature);
  const signatures = [expected.depositSignature, expected.claimSignature];
  const statuses = await readChain<{
    value: ({ err: unknown; confirmationStatus: string | null } | null)[];
  }>(expected, 'getSignatureStatuses', [
    signatures,
    { searchTransactionHistory: true },
  ]);
  assert.equal(statuses.value.length, signatures.length);
  for (const status of statuses.value) {
    assert.ok(status, 'Finalized signature unavailable.');
    assert.equal(status.err, null);
    assert.equal(status.confirmationStatus, FINALIZED_COMMITMENT);
  }
  const deposit = await finalizedTransaction(
    expected,
    expected.depositSignature,
  );
  const claim = await finalizedTransaction(expected, expected.claimSignature);
  assert.ok(deposit.slot <= claim.slot, 'Claim precedes deposit.');
  const { charged, refund, ...tokenEvidence } = await verifyEscrowTokens(
    deposit,
    claim,
    expected,
  );
  for (const transaction of [deposit, claim]) {
    const buyerIndex = transaction.transaction.message.accountKeys.findIndex(
      (key) => key.pubkey === expected.buyer,
    );
    if (buyerIndex >= 0)
      assert.equal(
        lamports(transaction, expected.buyer, true),
        lamports(transaction, expected.buyer, false),
      );
  }
  const escrowRent = verifyEscrowRent(deposit, claim, {
    escrowAta: await tokenAddress(expected.channelId, expected.mint),
    channelId: expected.channelId,
    feePayer: expected.feePayer,
  });
  const sponsorBefore = lamports(deposit, expected.feePayer, false);
  const sponsorAfter = lamports(claim, expected.feePayer, true);
  const sponsorDepositAfter = lamports(deposit, expected.feePayer, true);
  const sponsorClaimBefore = lamports(claim, expected.feePayer, false);
  const depositSponsorDelta = sponsorDepositAfter - sponsorBefore;
  const claimSponsorDelta = sponsorAfter - sponsorClaimBefore;
  assert.equal(lamports(deposit, expected.channelId, false), 0n);
  const initialChannelRent = lamports(deposit, expected.channelId, true);
  const channelClaimBefore = lamports(claim, expected.channelId, false);
  const retainedRent = lamports(claim, expected.channelId, true);
  assert.ok(
    channelClaimBefore >= initialChannelRent,
    'Channel rent decreased between transactions.',
  );
  assert.ok(
    retainedRent >= channelClaimBefore,
    'Retained channel lamports decreased during the claim.',
  );
  const fees = BigInt(deposit.meta.fee) + BigInt(claim.meta.fee);
  assert.equal(
    depositSponsorDelta +
      initialChannelRent +
      escrowRent.afterDeposit -
      escrowRent.beforeDeposit,
    -BigInt(deposit.meta.fee),
    'Deposit sponsor delta must equal its fee plus channel and escrow rent.',
  );
  assert.equal(
    claimSponsorDelta +
      retainedRent -
      channelClaimBefore +
      escrowRent.afterClaim -
      escrowRent.beforeClaim,
    -BigInt(claim.meta.fee),
    'Claim sponsor delta must equal its fee plus channel and escrow rent changes.',
  );
  const channel = await verifyFinalizedChannel({
    ...expected,
    chargedAtomic: charged.toString(),
  });
  const currentChannelLamports = BigInt(channel.lamports);
  assert.ok(
    currentChannelLamports >= retainedRent,
    'Retained channel lamports decreased after the claim.',
  );
  assert.ok(
    initialChannelRent >= BigInt(channel.minimumRentLamports),
    'Initial channel rent is below minimum.',
  );
  return {
    chargedAtomic: charged.toString(),
    refundAtomic: refund.toString(),
    ...tokenEvidence,
    depositSignature: expected.depositSignature,
    claimSignature: expected.claimSignature,
    depositSlot: deposit.slot,
    claimSlot: claim.slot,
    balanceDeltas: {
      buyer: (-charged).toString(),
      seller: charged.toString(),
      escrow: '0',
      buyerLamports: '0',
    },
    sponsorBeforeLamports: sponsorBefore.toString(),
    sponsorAfterLamports: sponsorAfter.toString(),
    sponsorDepositBeforeLamports: sponsorBefore.toString(),
    sponsorDepositAfterLamports: sponsorDepositAfter.toString(),
    sponsorClaimBeforeLamports: sponsorClaimBefore.toString(),
    sponsorClaimAfterLamports: sponsorAfter.toString(),
    sponsorDepositDeltaLamports: depositSponsorDelta.toString(),
    sponsorClaimDeltaLamports: claimSponsorDelta.toString(),
    sponsorTransactionDeltaLamports: (
      depositSponsorDelta + claimSponsorDelta
    ).toString(),
    sponsorInterveningDeltaLamports: (
      sponsorClaimBefore - sponsorDepositAfter
    ).toString(),
    escrowAccountRentLamports: escrowRent.afterDeposit.toString(),
    escrowDepositBeforeLamports: escrowRent.beforeDeposit.toString(),
    escrowDepositAfterLamports: escrowRent.afterDeposit.toString(),
    escrowClaimBeforeLamports: escrowRent.beforeClaim.toString(),
    escrowClaimAfterLamports: escrowRent.afterClaim.toString(),
    escrowInterveningCreditLamports:
      escrowRent.interveningCreditLamports.toString(),
    channelDepositBeforeLamports: '0',
    channelDepositAfterLamports: initialChannelRent.toString(),
    channelClaimBeforeLamports: channelClaimBefore.toString(),
    channelClaimAfterLamports: retainedRent.toString(),
    currentChannelLamports: currentChannelLamports.toString(),
    channelInterveningCreditLamports: (
      channelClaimBefore - initialChannelRent
    ).toString(),
    channelClaimDeltaLamports: (retainedRent - channelClaimBefore).toString(),
    channelPostClaimCreditLamports: (
      currentChannelLamports - retainedRent
    ).toString(),
    sponsorFeesLamports: fees.toString(),
    retainedChannelRentLamports: initialChannelRent.toString(),
    minimumChannelRentLamports: channel.minimumRentLamports,
  };
}
