// Rent and channel fault table: each entry mutates the payment fixture and names the guard that must
// reject it.
import { CHANNEL_PROGRAM, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import {
  PROOF_GUARDS,
  RENT_GUARDS,
  type FinancialGuardMessage,
} from '@gyblos/payments-x402/accounting/constants';
import {
  CHANNEL_GUARDS,
  type FinalizedChannelGuardMessage,
} from '@gyblos/payments-x402/constants';

import {
  accountIndex,
  accountInstruction,
  type PaymentFixture,
} from './payment-fixture.js';
import { lamportCredits, rentInfo } from './payment-mutations.js';

type Fault = readonly [
  FinancialGuardMessage | FinalizedChannelGuardMessage,
  (fixture: PaymentFixture) => void,
];

export const RENT_FAULTS: Record<string, Fault> = {
  'wrong escrow rent payer': [
    RENT_GUARDS.CREATION_PAYER,
    (f) => {
      rentInfo(f, true, 'createAccount').source = f.expected.buyer;
    },
  ],
  'wrong escrow account owner': [
    RENT_GUARDS.CREATION_OWNER,
    (f) => {
      rentInfo(f, true, 'createAccount').owner = f.expected.authorizer;
    },
  ],
  'wrong escrow account size': [
    RENT_GUARDS.CREATION_SIZE,
    (f) => {
      rentInfo(f, true, 'createAccount').space = 1;
    },
  ],
  'wrong escrow rent amount': [
    RENT_GUARDS.CREATION_AMOUNT,
    (f) => {
      const info = rentInfo(f, true, 'createAccount');
      info.lamports = Number(info.lamports) + 1;
    },
  ],
  'wrong escrow create program': [
    RENT_GUARDS.CREATION_PROGRAM,
    (f) => {
      accountInstruction(f, true, 'createAccount').programId = CHANNEL_PROGRAM;
    },
  ],
  'missing escrow creation': [
    RENT_GUARDS.CREATION_COUNT,
    (f) => {
      accountInstruction(f, true, 'createAccount').parsed!.type = 'omitted';
    },
  ],
  'duplicate escrow creation': [
    RENT_GUARDS.CREATION_COUNT,
    (f) => {
      f.source.deposit.transaction.message.instructions.push(
        structuredClone(accountInstruction(f, true, 'createAccount')),
      );
    },
  ],
  'wrong escrow close recipient': [
    RENT_GUARDS.CLOSURE_DESTINATION,
    (f) => {
      rentInfo(f, false, 'closeAccount').destination = f.expected.buyer;
    },
  ],
  'wrong escrow close authority': [
    RENT_GUARDS.CLOSURE_AUTHORITY,
    (f) => {
      rentInfo(f, false, 'closeAccount').owner = f.expected.buyer;
    },
  ],
  'missing escrow close': [
    RENT_GUARDS.CLOSURE_COUNT,
    (f) => {
      f.source.claim.transaction.message.instructions =
        f.source.claim.transaction.message.instructions.filter(
          (instruction) => instruction.parsed?.type !== 'closeAccount',
        );
      for (const group of f.source.claim.meta.innerInstructions ?? [])
        group.instructions = group.instructions.filter(
          (instruction) => instruction.parsed?.type !== 'closeAccount',
        );
    },
  ],
  'duplicate escrow close': [
    RENT_GUARDS.CLOSURE_COUNT,
    (f) => {
      f.source.claim.transaction.message.instructions.push(
        structuredClone(accountInstruction(f, false, 'closeAccount')),
      );
    },
  ],
  'prefunded escrow rent': [
    RENT_GUARDS.FRESH,
    (f) => {
      f.source.deposit.meta.preBalances[
        accountIndex(f.source.deposit, f.escrow)
      ] = 1;
    },
  ],
  'decreased escrow rent': [
    RENT_GUARDS.NONDECREASING,
    (f) => {
      f.source.claim.meta.preBalances[
        accountIndex(f.source.claim, f.escrow)
      ]! -= 1;

      f.source.claim.meta.postBalances[0]! -= 1;
    },
  ],
  'unclosed escrow rent': [
    RENT_GUARDS.CLOSED,
    (f) => {
      f.source.claim.meta.postBalances[accountIndex(f.source.claim, f.escrow)] =
        1;
    },
  ],
  'unsafe rent amount': [
    RENT_GUARDS.SAFE_LAMPORTS,
    (f) => {
      f.source.deposit.meta.postBalances[
        accountIndex(f.source.deposit, f.escrow)
      ] = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  'offsetting sponsor errors': [
    PROOF_GUARDS.DEPOSIT_SPONSOR,
    (f) => {
      f.source.deposit.meta.postBalances[0]! += 1;
      f.source.claim.meta.postBalances[0]! -= 1;
    },
  ],
  'shifted fees': [
    PROOF_GUARDS.DEPOSIT_SPONSOR,
    (f) => {
      f.source.deposit.meta.fee += 1;
      f.source.claim.meta.fee -= 1;
    },
  ],
  'buyer SOL charge': [
    PROOF_GUARDS.BUYER_SOL,
    (f) => {
      f.source.deposit.meta.postBalances[
        accountIndex(f.source.deposit, f.expected.buyer)
      ]! += 1;
    },
  ],
  'channel interval depletion': [
    PROOF_GUARDS.CHANNEL_INTERVAL,
    (f) => {
      lamportCredits(f, { interval: -1 });
      f.rent += 1;
    },
  ],
  'channel later depletion': [
    PROOF_GUARDS.CHANNEL_CURRENT,
    (f) => {
      lamportCredits(f, { interval: 1 });
      f.rent -= 1;
    },
  ],
  'wrong channel owner': [
    CHANNEL_GUARDS.CANONICAL,
    (f) => {
      f.owner = TOKEN_PROGRAM_ADDRESS;
    },
  ],
  'wrong canonical PDA': [
    CHANNEL_GUARDS.CANONICAL,
    (f) => {
      f.data.writeBigUInt64LE(f.data.readBigUInt64LE(4) + 1n, 4);
    },
  ],
  'wrong channel state': [
    CHANNEL_GUARDS.STATUS,
    (f) => {
      f.data[3] = 0;
    },
  ],
  'missing current channel': [
    CHANNEL_GUARDS.AVAILABLE,
    (f) => {
      f.accountMissing = true;
    },
  ],
  'initial rent below minimum': [
    PROOF_GUARDS.INITIAL_RENT,
    (f) => {
      f.minimum += 1;

      f.rent += 1;
    },
  ],
  'nonfinalized status': [
    PROOF_GUARDS.STATUS_FINALIZED,
    (f) => {
      f.confirmation = 'confirmed';
    },
  ],
  'missing finalized status': [
    PROOF_GUARDS.STATUS_FINALIZED,
    (f) => {
      f.confirmation = null;
    },
  ],
  'reused transaction signatures': [
    PROOF_GUARDS.SIGNATURES_DISTINCT,
    (f) => {
      f.expected.claimSignature = f.expected.depositSignature;
    },
  ],
  'transaction error': [
    PROOF_GUARDS.TRANSACTION_SUCCESS,
    (f) => {
      f.source.claim.meta.err = { custom: 1 };
    },
  ],
  'claim before deposit': [
    PROOF_GUARDS.ORDER,
    (f) => {
      f.source.claim.slot = f.source.deposit.slot - 1;
    },
  ],
  'wrong transaction signature': [
    PROOF_GUARDS.TRANSACTION_SIGNATURE,
    (f) => {
      f.source.claim.transaction.signatures[0] = f.expected.depositSignature;
    },
  ],
  'deposit-only sponsor equation': [
    PROOF_GUARDS.DEPOSIT_SPONSOR,
    (f) => {
      f.source.deposit.meta.postBalances[0]! += 1;
    },
  ],
  'claim-only sponsor equation': [
    PROOF_GUARDS.CLAIM_SPONSOR,
    (f) => {
      f.source.claim.meta.postBalances[0]! += 1;
    },
  ],
  'retained rent decreases during claim': [
    PROOF_GUARDS.CHANNEL_RETAINED,
    (f) => {
      f.source.claim.meta.postBalances[
        accountIndex(f.source.claim, f.expected.channelId)
      ]! -= 1;
      f.source.claim.meta.postBalances[0]! += 1;
    },
  ],
};
