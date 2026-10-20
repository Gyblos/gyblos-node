import assert from 'node:assert/strict';

import { getTokenSize } from '@solana-program/token';

import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';

import { RENT_GUARDS } from './constants.js';
import type { ChainTransaction } from './types.js';

export interface RentTransaction extends ChainTransaction {
  meta: ChainTransaction['meta'] & {
    preBalances: number[];
    postBalances: number[];
  };
}

interface EscrowRentAccounts {
  escrowAta: string;
  channelId: string;
  feePayer: string;
}

interface AccountInstruction {
  programId: string;
  info: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accountInstructions(
  transaction: ChainTransaction,
  type: string,
  field: string,
  account: string,
) {
  const matches: AccountInstruction[] = [];
  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta.innerInstructions ?? []).flatMap(
      (group) => group.instructions,
    ),
  ];
  for (const instruction of instructions) {
    const parsed: unknown = instruction.parsed;
    if (
      isRecord(parsed) &&
      parsed.type === type &&
      isRecord(parsed.info) &&
      parsed.info[field] === account
    )
      matches.push({ programId: instruction.programId, info: parsed.info });
  }
  return matches;
}

export function transactionLamports(
  transaction: RentTransaction,
  account: string,
  after: boolean,
) {
  const index = transaction.transaction.message.accountKeys.findIndex(
    (key) => key.pubkey === account,
  );
  assert.ok(index >= 0, RENT_GUARDS.ACCOUNT);
  const balances = after
    ? transaction.meta.postBalances
    : transaction.meta.preBalances;
  const value = balances[index];
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    RENT_GUARDS.SAFE_LAMPORTS,
  );
  return BigInt(value);
}

export function verifyEscrowRent(
  deposit: RentTransaction,
  claim: RentTransaction,
  expected: EscrowRentAccounts,
) {
  const beforeDeposit = transactionLamports(deposit, expected.escrowAta, false);
  const afterDeposit = transactionLamports(deposit, expected.escrowAta, true);
  const beforeClaim = transactionLamports(claim, expected.escrowAta, false);
  const afterClaim = transactionLamports(claim, expected.escrowAta, true);
  assert.equal(beforeDeposit, 0n, RENT_GUARDS.FRESH);
  assert.ok(afterDeposit > 0n, RENT_GUARDS.FUNDED);
  assert.ok(beforeClaim >= afterDeposit, RENT_GUARDS.NONDECREASING);
  assert.equal(afterClaim, 0n, RENT_GUARDS.CLOSED);

  const creations = accountInstructions(
    deposit,
    'createAccount',
    'newAccount',
    expected.escrowAta,
  );
  assert.equal(creations.length, 1, RENT_GUARDS.CREATION_COUNT);
  const creation = creations[0]!;
  assert.equal(
    creation.programId,
    SYSTEM_PROGRAM_ADDRESS,
    RENT_GUARDS.CREATION_PROGRAM,
  );
  assert.equal(
    creation.info.source,
    expected.feePayer,
    RENT_GUARDS.CREATION_PAYER,
  );
  assert.equal(
    creation.info.owner,
    TOKEN_PROGRAM_ADDRESS,
    RENT_GUARDS.CREATION_OWNER,
  );
  assert.equal(creation.info.space, getTokenSize(), RENT_GUARDS.CREATION_SIZE);
  const amount = creation.info.lamports;
  assert.ok(
    typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0,
    RENT_GUARDS.CREATION_SAFE_AMOUNT,
  );
  assert.equal(BigInt(amount), afterDeposit, RENT_GUARDS.CREATION_AMOUNT);

  const closures = accountInstructions(
    claim,
    'closeAccount',
    'account',
    expected.escrowAta,
  );
  assert.equal(closures.length, 1, RENT_GUARDS.CLOSURE_COUNT);
  const closure = closures[0]!;
  assert.equal(
    closure.programId,
    TOKEN_PROGRAM_ADDRESS,
    RENT_GUARDS.CLOSURE_PROGRAM,
  );
  assert.equal(
    closure.info.owner,
    expected.channelId,
    RENT_GUARDS.CLOSURE_AUTHORITY,
  );
  assert.equal(
    closure.info.destination,
    expected.feePayer,
    RENT_GUARDS.CLOSURE_DESTINATION,
  );

  return {
    beforeDeposit,
    afterDeposit,
    beforeClaim,
    afterClaim,
    interveningCreditLamports: beforeClaim - afterDeposit,
  };
}
