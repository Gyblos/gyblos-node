import assert from 'node:assert/strict';

import { FINALIZED_COMMITMENT, SVM_TRANSACTION_VERSION } from '@gyblos/config';
import { verifyFinalizedChannel } from '@gyblos/payments-x402/finalized-channel';

import { readChain, tokenAddress, transactionTransfers } from './chain.js';
import type { ChainTransaction } from './types.js';

interface TokenBalance {
  accountIndex: number;
  owner: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

interface FinalizedTransaction extends ChainTransaction {
  meta: ChainTransaction['meta'] & {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: TokenBalance[];
    postTokenBalances: TokenBalance[];
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

function accountIndex(transaction: FinalizedTransaction, account: string) {
  const index = transaction.transaction.message.accountKeys.findIndex(
    (key) => key.pubkey === account,
  );
  assert.ok(index >= 0, 'Required transaction account missing.');
  return index;
}

function lamports(
  transaction: FinalizedTransaction,
  account: string,
  after: boolean,
) {
  const value = (
    after ? transaction.meta.postBalances : transaction.meta.preBalances
  )[accountIndex(transaction, account)];
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'Unsafe lamport balance.',
  );
  return BigInt(value);
}

function tokens(
  transaction: FinalizedTransaction,
  account: string,
  owner: string,
  mint: string,
  after: boolean,
) {
  const index = transaction.transaction.message.accountKeys.findIndex(
    (key) => key.pubkey === account,
  );
  if (index < 0) return 0n; // An absent account cannot be changed by this transaction.
  const balances = after
    ? transaction.meta.postTokenBalances
    : transaction.meta.preTokenBalances;
  assert.ok(Array.isArray(balances));
  const balance = balances.find((item) => item.accountIndex === index);
  if (!balance) return 0n;
  assert.equal(balance.owner, owner);
  assert.equal(balance.mint, mint);
  assert.match(balance.uiTokenAmount.amount, /^\d+$/);
  return BigInt(balance.uiTokenAmount.amount);
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
  const buyerAta = await tokenAddress(expected.buyer, expected.mint);
  const sellerAta = await tokenAddress(expected.payTo, expected.mint);
  const escrowAta = await tokenAddress(expected.channelId, expected.mint);
  const transfers = (transaction: FinalizedTransaction) => {
    const items = transactionTransfers(transaction);
    for (const transfer of items) assert.match(transfer.amount, /^\d+$/);
    return items;
  };
  const sum = (
    transaction: FinalizedTransaction,
    source: string,
    destination: string,
  ) =>
    transfers(transaction)
      .filter(
        (transfer) =>
          transfer.source === source &&
          transfer.destination === destination &&
          transfer.mint === expected.mint,
      )
      .reduce((amount, transfer) => amount + BigInt(transfer.amount), 0n);
  assert.equal(sum(deposit, buyerAta, escrowAta), ceiling);
  const charged = sum(claim, escrowAta, sellerAta);
  const refund = sum(claim, escrowAta, buyerAta);
  assert.equal(charged + refund, ceiling);
  for (const transfer of transfers(claim).filter(
    (item) => item.source === escrowAta,
  )) {
    assert.equal(transfer.mint, expected.mint);
    assert.ok(
      transfer.destination === buyerAta || transfer.destination === sellerAta,
    );
  }
  const balance = (
    transaction: FinalizedTransaction,
    owner: string,
    ata: string,
    after: boolean,
  ) => tokens(transaction, ata, owner, expected.mint, after);
  const delta = (
    transaction: FinalizedTransaction,
    owner: string,
    ata: string,
  ) =>
    balance(transaction, owner, ata, true) -
    balance(transaction, owner, ata, false);
  assert.equal(delta(deposit, expected.buyer, buyerAta), -ceiling);
  assert.equal(delta(deposit, expected.payTo, sellerAta), 0n);
  assert.equal(balance(deposit, expected.channelId, escrowAta, false), 0n);
  assert.equal(balance(deposit, expected.channelId, escrowAta, true), ceiling);
  assert.equal(delta(claim, expected.buyer, buyerAta), refund);
  assert.equal(delta(claim, expected.payTo, sellerAta), charged);
  assert.equal(balance(claim, expected.channelId, escrowAta, false), ceiling);
  assert.equal(balance(claim, expected.channelId, escrowAta, true), 0n);
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
  const sponsorBefore = lamports(deposit, expected.feePayer, false);
  const sponsorAfter = lamports(claim, expected.feePayer, true);
  const sponsorDepositAfter = lamports(deposit, expected.feePayer, true);
  const sponsorClaimBefore = lamports(claim, expected.feePayer, false);
  const depositSponsorDelta = sponsorDepositAfter - sponsorBefore;
  const claimSponsorDelta = sponsorAfter - sponsorClaimBefore;
  assert.equal(lamports(deposit, expected.channelId, false), 0n);
  const retainedRent = lamports(claim, expected.channelId, true);
  assert.equal(
    lamports(deposit, expected.channelId, true),
    lamports(claim, expected.channelId, false),
  );
  const fees = BigInt(deposit.meta.fee) + BigInt(claim.meta.fee);
  assert.equal(
    depositSponsorDelta + lamports(deposit, expected.channelId, true),
    -BigInt(deposit.meta.fee),
    'Deposit sponsor delta must equal its fee plus channel rent.',
  );
  assert.equal(
    claimSponsorDelta +
      retainedRent -
      lamports(claim, expected.channelId, false),
    -BigInt(claim.meta.fee),
    'Claim sponsor delta must equal its fee plus channel rent change.',
  );
  const channel = await verifyFinalizedChannel({
    ...expected,
    chargedAtomic: charged.toString(),
  });
  assert.equal(BigInt(channel.lamports), retainedRent);
  return {
    chargedAtomic: charged.toString(),
    refundAtomic: refund.toString(),
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
    sponsorFeesLamports: fees.toString(),
    retainedChannelRentLamports: retainedRent.toString(),
    minimumChannelRentLamports: channel.minimumRentLamports,
  };
}
