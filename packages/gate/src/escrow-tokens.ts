import assert from 'node:assert/strict';

import { DEVNET_TREASURY_OWNER } from '@gyblos/config';

import { tokenAddress, transactionTransfers } from './chain.js';
import type { ChainTransaction } from './types.js';

interface TokenBalance {
  accountIndex: number;
  owner: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

export interface EscrowTokenTransaction extends ChainTransaction {
  meta: ChainTransaction['meta'] & {
    preTokenBalances: TokenBalance[];
    postTokenBalances: TokenBalance[];
  };
}

interface EscrowTokenExpectation {
  buyer: string;
  payTo: string;
  channelId: string;
  mint: string;
  ceiling: string;
}

function tokens(
  transaction: EscrowTokenTransaction,
  account: string,
  owner: string,
  mint: string,
  after: boolean,
) {
  const keys = transaction.transaction.message.accountKeys;
  assert.ok(
    keys.filter((key) => key.pubkey === account).length <= 1,
    'Duplicate token account key.',
  );
  const index = keys.findIndex((key) => key.pubkey === account);
  if (index < 0) return 0n;
  const balances = after
    ? transaction.meta.postTokenBalances
    : transaction.meta.preTokenBalances;
  assert.ok(Array.isArray(balances));
  const matches = balances.filter((item) => item.accountIndex === index);
  assert.ok(matches.length <= 1, 'Duplicate token balance.');
  const balance = matches[0];
  if (!balance) return 0n;
  assert.equal(balance.owner, owner);
  assert.equal(balance.mint, mint);
  assert.match(balance.uiTokenAmount.amount, /^\d+$/);
  return BigInt(balance.uiTokenAmount.amount);
}

function transfers(transaction: EscrowTokenTransaction, mint: string) {
  const items = transactionTransfers(transaction);
  for (const item of items) {
    assert.equal(item.mint, mint);
    assert.match(item.amount, /^\d+$/);
  }
  return items;
}

export async function verifyEscrowTokens(
  deposit: EscrowTokenTransaction,
  claim: EscrowTokenTransaction,
  expected: EscrowTokenExpectation,
) {
  assert.match(expected.ceiling, /^\d+$/);
  const ceiling = BigInt(expected.ceiling);
  assert.ok(ceiling > 0n);
  const [buyerAta, sellerAta, escrowAta, treasuryAta] = await Promise.all([
    tokenAddress(expected.buyer, expected.mint),
    tokenAddress(expected.payTo, expected.mint),
    tokenAddress(expected.channelId, expected.mint),
    tokenAddress(DEVNET_TREASURY_OWNER, expected.mint),
  ]);
  const accounts = [buyerAta, sellerAta, escrowAta, treasuryAta];
  assert.equal(
    new Set(accounts).size,
    accounts.length,
    'Buyer, seller, escrow and treasury token accounts must be distinct.',
  );
  const depositTransfers = transfers(deposit, expected.mint);
  for (const transfer of depositTransfers) {
    assert.equal(transfer.source, buyerAta);
    assert.equal(transfer.destination, escrowAta);
  }
  assert.equal(
    depositTransfers.reduce(
      (sum, transfer) => sum + BigInt(transfer.amount),
      0n,
    ),
    ceiling,
  );
  const claimTransfers = transfers(claim, expected.mint);
  const destinations = new Set<string>([buyerAta, sellerAta, treasuryAta]);
  for (const transfer of claimTransfers) {
    assert.equal(transfer.source, escrowAta);
    assert.ok(destinations.has(transfer.destination));
  }
  const sum = (destination: string) =>
    claimTransfers
      .filter((transfer) => transfer.destination === destination)
      .reduce((total, transfer) => total + BigInt(transfer.amount), 0n);
  const charged = sum(sellerAta);
  const refund = sum(buyerAta);
  const treasurySweep = sum(treasuryAta);
  assert.equal(charged + refund, ceiling);
  const balance = (
    transaction: EscrowTokenTransaction,
    owner: string,
    account: string,
    after: boolean,
  ) => tokens(transaction, account, owner, expected.mint, after);
  const delta = (
    transaction: EscrowTokenTransaction,
    owner: string,
    account: string,
  ) =>
    balance(transaction, owner, account, true) -
    balance(transaction, owner, account, false);
  const depositBefore = balance(deposit, expected.channelId, escrowAta, false);
  const depositAfter = balance(deposit, expected.channelId, escrowAta, true);
  const claimBefore = balance(claim, expected.channelId, escrowAta, false);
  const claimAfter = balance(claim, expected.channelId, escrowAta, true);
  assert.equal(depositBefore, 0n);
  assert.equal(depositAfter, ceiling);
  assert.ok(claimBefore >= depositAfter, 'Escrow principal decreased.');
  assert.equal(claimAfter, 0n);
  const credit = claimBefore - depositAfter;
  assert.equal(
    treasurySweep,
    credit,
    'Treasury sweep must equal token surplus.',
  );
  assert.equal(delta(deposit, expected.buyer, buyerAta), -ceiling);
  assert.equal(delta(deposit, expected.payTo, sellerAta), 0n);
  assert.equal(delta(deposit, DEVNET_TREASURY_OWNER, treasuryAta), 0n);
  assert.equal(delta(claim, expected.buyer, buyerAta), refund);
  assert.equal(delta(claim, expected.payTo, sellerAta), charged);
  assert.equal(delta(claim, DEVNET_TREASURY_OWNER, treasuryAta), treasurySweep);
  return {
    charged,
    refund,
    escrowDepositBeforeAtomic: depositBefore.toString(),
    escrowDepositAfterAtomic: depositAfter.toString(),
    escrowClaimBeforeAtomic: claimBefore.toString(),
    escrowClaimAfterAtomic: claimAfter.toString(),
    escrowInterveningTokenCreditAtomic: credit.toString(),
    treasurySweepAtomic: treasurySweep.toString(),
  };
}
