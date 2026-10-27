// Proves a settled payment from finalized chain data: both signatures finalized and successful, sponsor-paid,
// with token and rent accounting checked. Read-only.
import assert from 'node:assert/strict';

import { FINALIZED_COMMITMENT, SVM_TRANSACTION_VERSION } from '@gyblos/config';

import { verifyFinalizedChannel } from '../finalized-channel';
import { readChain, tokenAddress } from './chain';
import { PROOF_GUARDS } from './constants';
import {
  transactionLamports as lamports,
  verifyEscrowRent,
} from './escrow-rent';
import {
  verifyEscrowTokens,
  type EscrowTokenTransaction,
} from './escrow-tokens';

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
  assert.ok(signature.length > 0, PROOF_GUARDS.SIGNATURE_REQUIRED);
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
  assert.ok(transaction, PROOF_GUARDS.TRANSACTION_AVAILABLE);
  assert.equal(transaction.meta.err, null, PROOF_GUARDS.TRANSACTION_SUCCESS);
  assert.ok(
    Number.isSafeInteger(transaction.slot) && transaction.slot >= 0,
    PROOF_GUARDS.TRANSACTION_SLOT,
  );
  assert.equal(
    transaction.transaction.signatures[0],
    signature,
    PROOF_GUARDS.TRANSACTION_SIGNATURE,
  );
  assert.equal(
    transaction.transaction.message.accountKeys[0]?.pubkey,
    expected.feePayer,
    PROOF_GUARDS.TRANSACTION_SPONSOR,
  );
  assert.ok(
    Number.isSafeInteger(transaction.meta.fee) && transaction.meta.fee >= 0,
    PROOF_GUARDS.TRANSACTION_FEE,
  );
  return transaction;
}

export async function finalizedPaymentProof(
  expected: FinalizedPaymentExpectation,
) {
  assert.match(expected.ceiling, /^\d+$/, PROOF_GUARDS.CEILING_FORMAT);
  const ceiling = BigInt(expected.ceiling);
  assert.ok(ceiling > 0n, PROOF_GUARDS.CEILING_POSITIVE);
  assert.notEqual(
    expected.depositSignature,
    expected.claimSignature,
    PROOF_GUARDS.SIGNATURES_DISTINCT,
  );
  const signatures = [expected.depositSignature, expected.claimSignature];
  const statuses = await readChain<{
    value: ({ err: unknown; confirmationStatus: string | null } | null)[];
  }>(expected, 'getSignatureStatuses', [
    signatures,
    { searchTransactionHistory: true },
  ]);
  assert.equal(
    statuses.value.length,
    signatures.length,
    PROOF_GUARDS.STATUS_COUNT,
  );
  for (const status of statuses.value) {
    assert.ok(status, PROOF_GUARDS.STATUS_AVAILABLE);
    assert.equal(status.err, null, PROOF_GUARDS.STATUS_SUCCESS);
    assert.equal(
      status.confirmationStatus,
      FINALIZED_COMMITMENT,
      PROOF_GUARDS.STATUS_FINALIZED,
    );
  }
  const deposit = await finalizedTransaction(
    expected,
    expected.depositSignature,
  );
  const claim = await finalizedTransaction(expected, expected.claimSignature);
  assert.ok(deposit.slot <= claim.slot, PROOF_GUARDS.ORDER);
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
        PROOF_GUARDS.BUYER_SOL,
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
  assert.equal(
    lamports(deposit, expected.channelId, false),
    0n,
    PROOF_GUARDS.CHANNEL_FRESH,
  );
  const initialChannelRent = lamports(deposit, expected.channelId, true);
  const channelClaimBefore = lamports(claim, expected.channelId, false);
  const retainedRent = lamports(claim, expected.channelId, true);
  assert.ok(
    channelClaimBefore >= initialChannelRent,
    PROOF_GUARDS.CHANNEL_INTERVAL,
  );
  assert.ok(retainedRent >= channelClaimBefore, PROOF_GUARDS.CHANNEL_RETAINED);
  const fees = BigInt(deposit.meta.fee) + BigInt(claim.meta.fee);
  assert.equal(
    depositSponsorDelta +
      initialChannelRent +
      escrowRent.afterDeposit -
      escrowRent.beforeDeposit,
    -BigInt(deposit.meta.fee),
    PROOF_GUARDS.DEPOSIT_SPONSOR,
  );
  assert.equal(
    claimSponsorDelta +
      retainedRent -
      channelClaimBefore +
      escrowRent.afterClaim -
      escrowRent.beforeClaim,
    -BigInt(claim.meta.fee),
    PROOF_GUARDS.CLAIM_SPONSOR,
  );
  const channel = await verifyFinalizedChannel({
    ...expected,
    chargedAtomic: charged.toString(),
  });
  const currentChannelLamports = BigInt(channel.lamports);
  assert.ok(
    currentChannelLamports >= retainedRent,
    PROOF_GUARDS.CHANNEL_CURRENT,
  );
  assert.ok(
    initialChannelRent >= BigInt(channel.minimumRentLamports),
    PROOF_GUARDS.INITIAL_RENT,
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
