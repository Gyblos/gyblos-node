import assert from 'node:assert/strict';

import { getTokenSize } from '@solana-program/token';

import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';

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
  assert.ok(index >= 0, 'Required transaction account missing.');
  const balances = after
    ? transaction.meta.postBalances
    : transaction.meta.preBalances;
  const value = balances[index];
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'Unsafe lamport balance.',
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
  assert.equal(beforeDeposit, 0n, 'A fresh escrow account is required.');
  assert.ok(afterDeposit > 0n, 'Escrow account rent is required.');
  assert.ok(
    beforeClaim >= afterDeposit,
    'Escrow rent decreased between transactions.',
  );
  assert.equal(afterClaim, 0n, 'The escrow account must be closed.');

  const creations = accountInstructions(
    deposit,
    'createAccount',
    'newAccount',
    expected.escrowAta,
  );
  assert.equal(
    creations.length,
    1,
    'One canonical escrow creation is required.',
  );
  const creation = creations[0]!;
  assert.equal(creation.programId, SYSTEM_PROGRAM_ADDRESS);
  assert.equal(creation.info.source, expected.feePayer);
  assert.equal(creation.info.owner, TOKEN_PROGRAM_ADDRESS);
  assert.equal(creation.info.space, getTokenSize());
  const amount = creation.info.lamports;
  assert.ok(
    typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0,
  );
  assert.equal(BigInt(amount), afterDeposit);

  const closures = accountInstructions(
    claim,
    'closeAccount',
    'account',
    expected.escrowAta,
  );
  assert.equal(closures.length, 1, 'One canonical escrow closure is required.');
  const closure = closures[0]!;
  assert.equal(closure.programId, TOKEN_PROGRAM_ADDRESS);
  assert.equal(closure.info.owner, expected.channelId);
  assert.equal(closure.info.destination, expected.feePayer);

  return {
    beforeDeposit,
    afterDeposit,
    beforeClaim,
    afterClaim,
    interveningCreditLamports: beforeClaim - afterDeposit,
  };
}
