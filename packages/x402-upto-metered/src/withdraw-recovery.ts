// Validates durable withdrawal metadata and resolves only its original finalized transaction.
// Control resolution is not financial proof and never signs or sends a replacement here.
import { isSignature, signature } from '@solana/kit';

import {
  UPTO_CHANNEL_ACCOUNT,
  UPTO_ERROR_CODES,
  UPTO_FINAL_COMMITMENT,
  UPTO_U64_MAX,
  UPTO_WITHDRAW,
  UPTO_WITHDRAW_STEPS,
} from './constants';
import { UptoError } from './errors';
import { uptoRead } from './transactions';
import type {
  UptoWithdrawalAttempt,
  UptoWithdrawalRecovery,
  UptoWithdrawResult,
  UptoWithdrawRpc,
} from './withdraw';

const FIELDS = [
  'step',
  'transaction',
  'lastValidBlockHeight',
  'checkedSlot',
  'pending',
] as const;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const height = (value: unknown): value is string =>
  typeof value === 'string' &&
  DECIMAL.test(value) &&
  BigInt(value) <= UPTO_U64_MAX;

export function parseUptoWithdrawalAttempt(
  value: unknown,
): UptoWithdrawalAttempt {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== FIELDS.length ||
    !FIELDS.every((key) => Object.hasOwn(value, key))
  )
    throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
  if (!(
    'step' in value &&
    'transaction' in value &&
    'lastValidBlockHeight' in value &&
    'checkedSlot' in value &&
    'pending' in value
  ))
    throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
  const { step, transaction, lastValidBlockHeight, checkedSlot, pending } =
    value;
  if (
    (step !== UPTO_WITHDRAW_STEPS.CLOSE_REQUESTED &&
      step !== UPTO_WITHDRAW_STEPS.DISTRIBUTED) ||
    typeof transaction !== 'string' ||
    !isSignature(transaction) ||
    !height(lastValidBlockHeight) ||
    !height(checkedSlot) ||
    typeof pending !== 'boolean'
  )
    throw new UptoError(UPTO_ERROR_CODES.INVALID_TERMS);
  return { step, transaction, lastValidBlockHeight, checkedSlot, pending };
}

export interface WithdrawalBank {
  commitment: typeof UPTO_FINAL_COMMITMENT;
  minContextSlot: bigint;
}
type WithdrawalView<Channel> =
  | { result: UptoWithdrawResult }
  | {
      channel: Channel | undefined;
      slot: string;
      previous?: UptoWithdrawalAttempt;
      save(attempt: UptoWithdrawalAttempt): Promise<void>;
      readOnly: boolean;
    };

const waiting = (attempt: UptoWithdrawalAttempt): UptoWithdrawResult => ({
  step: attempt.step,
  transaction: attempt.transaction,
  confirmed: false,
  retryAfterSeconds: UPTO_WITHDRAW.recheckSeconds,
});

async function finalizedBank(
  rpc: UptoWithdrawRpc,
  previous?: UptoWithdrawalAttempt,
) {
  if (!rpc.getEpochInfo) throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  const tip = await uptoRead(
    rpc.getEpochInfo({ commitment: UPTO_FINAL_COMMITMENT }),
  );
  if (
    typeof tip.absoluteSlot !== 'bigint' ||
    typeof tip.blockHeight !== 'bigint' ||
    tip.absoluteSlot < 0n ||
    tip.blockHeight < 0n ||
    (previous && tip.absoluteSlot < BigInt(previous.checkedSlot))
  )
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  const bank: WithdrawalBank = {
    commitment: UPTO_FINAL_COMMITMENT,
    minContextSlot: tip.absoluteSlot,
  };
  return { tip, bank };
}

async function originalStatus(
  rpc: UptoWithdrawRpc,
  previous: UptoWithdrawalAttempt,
  minSlot: bigint,
) {
  const statuses = await uptoRead(
    rpc.getSignatureStatuses([signature(previous.transaction)], {
      searchTransactionHistory: true,
    }),
  );
  if (
    !statuses.context ||
    typeof statuses.context.slot !== 'bigint' ||
    statuses.context.slot < minSlot ||
    statuses.value.length !== 1
  )
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  const status = statuses.value[0];
  if (
    status &&
    (!Object.hasOwn(status, 'err') ||
      !Object.hasOwn(status, 'confirmationStatus'))
  )
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  return status;
}

export async function recoverWithdrawal<Channel extends { status: number }>(
  rpc: UptoWithdrawRpc,
  recovery: UptoWithdrawalRecovery,
  readChannel: (bank: WithdrawalBank) => Promise<Channel | undefined>,
): Promise<WithdrawalView<Channel>> {
  const previous =
    recovery.previous && parseUptoWithdrawalAttempt(recovery.previous);
  const persist = recovery.save.bind(recovery);
  const save = async (attempt: UptoWithdrawalAttempt) => {
    try {
      await persist({ ...attempt });
    } catch {
      throw new UptoError(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE);
    }
  };
  const readOnly = recovery.readOnly === true;
  const { tip, bank } = await finalizedBank(rpc, previous);
  if (!previous)
    return {
      channel: await readChannel(bank),
      slot: String(bank.minContextSlot),
      save,
      previous,
      readOnly,
    };
  const status = await originalStatus(rpc, previous, tip.absoluteSlot);
  if (status?.confirmationStatus === UPTO_FINAL_COMMITMENT) {
    if (typeof status.slot !== 'bigint' || !Object.hasOwn(status, 'err'))
      throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
    if (status.slot > bank.minContextSlot) bank.minContextSlot = status.slot;
  } else if (
    status ||
    tip.blockHeight <= BigInt(previous.lastValidBlockHeight)
  ) {
    return { result: waiting(previous) };
  }
  const channel = await readChannel(bank);
  const finalized = status?.confirmationStatus === UPTO_FINAL_COMMITMENT;
  if (!finalized && !channel && previous.pending)
    return { result: waiting(previous) };
  if (finalized && status.err === null && channel) {
    const states = UPTO_CHANNEL_ACCOUNT.statuses;
    if (
      channel.status === states.OPEN ||
      (previous.step === UPTO_WITHDRAW_STEPS.DISTRIBUTED &&
        channel.status !== states.DISTRIBUTED)
    )
      throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  }
  if (!previous.pending)
    return {
      channel,
      slot: String(bank.minContextSlot),
      save,
      previous,
      readOnly,
    };
  await save({
    ...previous,
    pending: false,
    checkedSlot: String(bank.minContextSlot),
  });
  if (finalized && status.err !== null)
    throw new UptoError(UPTO_ERROR_CODES.CHAIN_REJECTED);
  return { result: { ...waiting(previous), confirmed: finalized } };
}
