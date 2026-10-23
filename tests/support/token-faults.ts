// Token fault table: each entry mutates the payment fixture's balances or transfers and names the guard
// that must reject it.
import assert from 'node:assert/strict';

import { DEVNET_TREASURY_OWNER } from '@gyblos/config';
import {
  TOKEN_GUARDS,
  type FinancialGuardMessage,
} from '@gyblos/payments-x402/accounting/constants';
import {
  CHANNEL_GUARDS,
  type FinalizedChannelGuardMessage,
} from '@gyblos/payments-x402/constants';

import {
  accountIndex,
  instructions,
  type PaymentFixture,
} from './payment-fixture.js';
import {
  paymentAccounts,
  shiftTokenBalance,
  tokenBalance,
  tokenCredit,
  tokenLeg,
} from './payment-mutations.js';

type Fault = readonly [
  FinancialGuardMessage | FinalizedChannelGuardMessage,
  (
    fixture: PaymentFixture,
    accounts: Awaited<ReturnType<typeof paymentAccounts>>,
    sweep: Awaited<ReturnType<typeof tokenCredit>>,
  ) => void,
];

export const TOKEN_FAULTS: Record<string, Fault> = {
  'wrong treasury recipient': [
    TOKEN_GUARDS.CLAIM_DESTINATION,
    (f, _a, sweep) => {
      sweep.info.destination = f.expected.authorizer;
    },
  ],
  'wrong treasury owner': [
    TOKEN_GUARDS.BALANCE_OWNER,
    (f, a) => {
      tokenBalance(f, a.treasuryAta, true).owner = f.expected.buyer;
    },
  ],
  'wrong treasury mint': [
    TOKEN_GUARDS.BALANCE_MINT,
    (f, a) => {
      tokenBalance(f, a.treasuryAta, true).mint = f.expected.authorizer;
    },
  ],
  'wrong escrow owner': [
    TOKEN_GUARDS.BALANCE_OWNER,
    (f) => {
      tokenBalance(f, f.escrow, false).owner = f.expected.buyer;
    },
  ],
  'wrong escrow mint': [
    TOKEN_GUARDS.BALANCE_MINT,
    (f) => {
      tokenBalance(f, f.escrow, false).mint = f.expected.authorizer;
    },
  ],
  'wrong transfer mint': [
    TOKEN_GUARDS.TRANSFER_MINT,
    (f, _a, sweep) => {
      sweep.info.mint = f.expected.authorizer;
    },
  ],
  'short treasury sweep': [
    TOKEN_GUARDS.SURPLUS,
    (_f, _a, sweep) => {
      sweep.info.tokenAmount.amount = '0';
    },
  ],
  'excess treasury sweep': [
    TOKEN_GUARDS.SURPLUS,
    (_f, _a, sweep) => {
      sweep.info.tokenAmount.amount = '2';
    },
  ],
  'wrong treasury balance delta': [
    TOKEN_GUARDS.TREASURY_DELTA,
    (f, a) => {
      shiftTokenBalance(f, a.treasuryAta, 1n, true);
    },
  ],
  'wrong buyer refund delta': [
    TOKEN_GUARDS.BUYER_REFUND,
    (f, a) => {
      shiftTokenBalance(f, a.buyerAta, 1n, true);
    },
  ],
  'wrong seller charge delta': [
    TOKEN_GUARDS.SELLER_CHARGE,
    (f, a) => {
      shiftTokenBalance(f, a.sellerAta, 1n, true);
    },
  ],
  'principal loss': [
    TOKEN_GUARDS.PRINCIPAL_TOTAL,
    (f, a) => {
      const leg = tokenLeg(f, a.buyerAta);
      leg.info.tokenAmount.amount = (
        BigInt(leg.info.tokenAmount.amount) - 1n
      ).toString();

      shiftTokenBalance(f, a.buyerAta, -1n, true);
    },
  ],
  'surplus disguised as refund': [
    TOKEN_GUARDS.PRINCIPAL_TOTAL,
    (f, a, sweep) => {
      tokenLeg(f, a.buyerAta).info.tokenAmount.amount = (
        BigInt(tokenLeg(f, a.buyerAta).info.tokenAmount.amount) + 1n
      ).toString();
      sweep.info.tokenAmount.amount = '0';
    },
  ],
  'surplus disguised as charge': [
    TOKEN_GUARDS.PRINCIPAL_TOTAL,
    (f, a, sweep) => {
      tokenLeg(f, a.sellerAta).info.tokenAmount.amount = (
        BigInt(tokenLeg(f, a.sellerAta).info.tokenAmount.amount) + 1n
      ).toString();
      sweep.info.tokenAmount.amount = '0';
    },
  ],
  'prefunded escrow': [
    TOKEN_GUARDS.ESCROW_FRESH,
    (f) => {
      const balance = structuredClone(tokenBalance(f, f.escrow, false));
      balance.accountIndex = accountIndex(f.source.deposit, f.escrow);
      balance.uiTokenAmount.amount = '1';
      f.source.deposit.meta.preTokenBalances.push(balance);
    },
  ],
  'principal decreased before claim': [
    TOKEN_GUARDS.PRINCIPAL,
    (f) => {
      shiftTokenBalance(f, f.escrow, -2n, false);
    },
  ],
  'nonempty final escrow': [
    TOKEN_GUARDS.ESCROW_EMPTY,
    (f) => {
      const row = structuredClone(tokenBalance(f, f.escrow, false));
      row.uiTokenAmount.amount = '1';
      f.source.claim.meta.postTokenBalances.push(row);
    },
  ],
  'duplicate balance row': [
    TOKEN_GUARDS.UNIQUE_BALANCE,
    (f, a) => {
      f.source.claim.meta.postTokenBalances.push(
        structuredClone(tokenBalance(f, a.treasuryAta, true)),
      );
    },
  ],
  'duplicate account key': [
    TOKEN_GUARDS.UNIQUE_ACCOUNT,
    (f, a) => {
      const key = f.source.claim.transaction.message.accountKeys.find(
        (key) => key.pubkey === a.treasuryAta,
      );
      assert.ok(key);
      f.source.claim.transaction.message.accountKeys.push(structuredClone(key));
    },
  ],
  'canonical settlement differs': [
    CHANNEL_GUARDS.SETTLED,
    (f) => {
      f.data.writeBigUInt64LE(0n, 20);
      f.data.writeBigUInt64LE(0n, 28);
    },
  ],
  'seller aliases treasury': [
    TOKEN_GUARDS.DISTINCT_ACCOUNTS,
    (f) => {
      f.expected.payTo = DEVNET_TREASURY_OWNER;
    },
  ],
  'negative token balance': [
    TOKEN_GUARDS.BALANCE_AMOUNT,
    (f) => {
      tokenBalance(f, f.escrow, false).uiTokenAmount.amount = '-1';
    },
  ],
  'claim-time incoming tokens': [
    TOKEN_GUARDS.CLAIM_SOURCE,
    (f, a, sweep) => {
      sweep.info.source = a.buyerAta;
      sweep.info.destination = f.escrow;
    },
  ],
  'deposit from a third party': [
    TOKEN_GUARDS.DEPOSIT_SOURCE,
    (f) => {
      const leg = instructions(f.source.deposit).find(
        (ix) => ix.parsed?.type === 'transferChecked',
      );
      assert.ok(leg?.parsed);
      leg.parsed.info.source = f.expected.authorizer;
    },
  ],
  'treasury sweep differs from observed surplus': [
    TOKEN_GUARDS.SURPLUS,
    (f) => {
      shiftTokenBalance(f, f.escrow, 1n, false);
    },
  ],
};
