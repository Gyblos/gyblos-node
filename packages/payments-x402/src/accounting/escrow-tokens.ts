// Owns escrow tokens in payments-x402; it must not know inference engines or lab orchestration.
import assert from 'node:assert/strict';

import { DEVNET_TREASURY_OWNER } from '@gyblos/config';

import { tokenAddress, transactionTransfers } from './chain.js';
import { TOKEN_GUARDS } from './constants.js';
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
    TOKEN_GUARDS.UNIQUE_ACCOUNT,
  );
  const index = keys.findIndex((key) => key.pubkey === account);
  if (index < 0) return 0n;
  const balances = after
    ? transaction.meta.postTokenBalances
    : transaction.meta.preTokenBalances;
  assert.ok(Array.isArray(balances), TOKEN_GUARDS.BALANCE_ARRAY);
  const matches = balances.filter((item) => item.accountIndex === index);
  assert.ok(matches.length <= 1, TOKEN_GUARDS.UNIQUE_BALANCE);
  const balance = matches[0];
  if (!balance) return 0n;
  assert.equal(balance.owner, owner, TOKEN_GUARDS.BALANCE_OWNER);
  assert.equal(balance.mint, mint, TOKEN_GUARDS.BALANCE_MINT);
  assert.match(
    balance.uiTokenAmount.amount,
    /^\d+$/,
    TOKEN_GUARDS.BALANCE_AMOUNT,
  );
  return BigInt(balance.uiTokenAmount.amount);
}

function transfers(transaction: EscrowTokenTransaction, mint: string) {
  const items = transactionTransfers(transaction);
  for (const item of items) {
    assert.equal(item.mint, mint, TOKEN_GUARDS.TRANSFER_MINT);
    assert.match(item.amount, /^\d+$/, TOKEN_GUARDS.TRANSFER_AMOUNT);
  }
  return items;
}

export async function verifyEscrowTokens(
  deposit: EscrowTokenTransaction,
  claim: EscrowTokenTransaction,
  expected: EscrowTokenExpectation,
) {
  assert.match(expected.ceiling, /^\d+$/, TOKEN_GUARDS.CEILING_FORMAT);
  const ceiling = BigInt(expected.ceiling);
  assert.ok(ceiling > 0n, TOKEN_GUARDS.CEILING_POSITIVE);
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
    TOKEN_GUARDS.DISTINCT_ACCOUNTS,
  );
  const depositTransfers = transfers(deposit, expected.mint);
  for (const transfer of depositTransfers) {
    assert.equal(transfer.source, buyerAta, TOKEN_GUARDS.DEPOSIT_SOURCE);
    assert.equal(
      transfer.destination,
      escrowAta,
      TOKEN_GUARDS.DEPOSIT_DESTINATION,
    );
  }
  assert.equal(
    depositTransfers.reduce(
      (sum, transfer) => sum + BigInt(transfer.amount),
      0n,
    ),
    ceiling,
    TOKEN_GUARDS.DEPOSIT_TOTAL,
  );
  const claimTransfers = transfers(claim, expected.mint);
  const destinations = new Set<string>([buyerAta, sellerAta, treasuryAta]);
  for (const transfer of claimTransfers) {
    assert.equal(transfer.source, escrowAta, TOKEN_GUARDS.CLAIM_SOURCE);
    assert.ok(
      destinations.has(transfer.destination),
      TOKEN_GUARDS.CLAIM_DESTINATION,
    );
  }
  const sum = (destination: string) =>
    claimTransfers
      .filter((transfer) => transfer.destination === destination)
      .reduce((total, transfer) => total + BigInt(transfer.amount), 0n);
  const charged = sum(sellerAta);
  const refund = sum(buyerAta);
  const treasurySweep = sum(treasuryAta);
  assert.equal(charged + refund, ceiling, TOKEN_GUARDS.PRINCIPAL_TOTAL);
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
  assert.equal(depositBefore, 0n, TOKEN_GUARDS.ESCROW_FRESH);
  assert.equal(depositAfter, ceiling, TOKEN_GUARDS.ESCROW_FUNDED);
  assert.ok(claimBefore >= depositAfter, TOKEN_GUARDS.PRINCIPAL);
  assert.equal(claimAfter, 0n, TOKEN_GUARDS.ESCROW_EMPTY);
  const credit = claimBefore - depositAfter;
  assert.equal(treasurySweep, credit, TOKEN_GUARDS.SURPLUS);
  assert.equal(
    delta(deposit, expected.buyer, buyerAta),
    -ceiling,
    TOKEN_GUARDS.BUYER_DEPOSIT,
  );
  assert.equal(
    delta(deposit, expected.payTo, sellerAta),
    0n,
    TOKEN_GUARDS.SELLER_DEPOSIT,
  );
  assert.equal(
    delta(deposit, DEVNET_TREASURY_OWNER, treasuryAta),
    0n,
    TOKEN_GUARDS.TREASURY_DEPOSIT,
  );
  assert.equal(
    delta(claim, expected.buyer, buyerAta),
    refund,
    TOKEN_GUARDS.BUYER_REFUND,
  );
  assert.equal(
    delta(claim, expected.payTo, sellerAta),
    charged,
    TOKEN_GUARDS.SELLER_CHARGE,
  );
  assert.equal(
    delta(claim, DEVNET_TREASURY_OWNER, treasuryAta),
    treasurySweep,
    TOKEN_GUARDS.TREASURY_DELTA,
  );
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
