// New withdrawal metadata and CAS updates share the existing journal's serialized private write.
// Opening timestamps/policy stay unchanged; control resolution never establishes payment settlement.
import {
  parseUptoWithdrawalAttempt,
  type UptoWithdrawalAttempt,
  type UptoWithdrawalRecovery,
} from 'x402-upto-metered';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import type { UptoBuyerJournal, UptoJournalEntry } from './buyer-journal';
import { BUYER_JOURNAL } from './constants';

export interface WithdrawalJournal {
  recordWithdrawal?(
    requestDigest: string,
    channelId: string,
    expected: UptoWithdrawalAttempt | undefined,
    next: UptoWithdrawalAttempt,
  ): Promise<void>;
}

export const hasPendingWithdrawal = (entry: UptoJournalEntry) =>
  entry.withdrawal?.pending === true;
export const blocksBuyerPayments = (entry: UptoJournalEntry) =>
  entry.channelId !== null &&
  (entry.state !== PAYMENT_CHANNEL_STATES.SETTLED ||
    hasPendingWithdrawal(entry));
export const matchesJournalFields = (
  value: Record<string, unknown>,
  version: number,
  fields: readonly string[],
) => {
  const extra = Number(
    version === BUYER_JOURNAL.version && Object.hasOwn(value, 'withdrawal'),
  );
  return (
    Object.keys(value).length === fields.length + extra &&
    fields.every((field) => Object.hasOwn(value, field))
  );
};
export const sameWithdrawal = (
  left: UptoWithdrawalAttempt | undefined,
  right: UptoWithdrawalAttempt | undefined,
) => JSON.stringify(left) === JSON.stringify(right);

function unavailable(): never {
  throw new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
}

export function journalWithdrawal(
  value: unknown,
  signed = true,
): {
  withdrawal?: UptoWithdrawalAttempt;
} {
  if (value === undefined) return {};
  if (!signed) unavailable();
  try {
    return { withdrawal: parseUptoWithdrawalAttempt(value) };
  } catch {
    return unavailable();
  }
}

export function recordJournalWithdrawal(
  entries: Map<string, UptoJournalEntry>,
  requestDigest: string,
  channelId: string,
  expected: UptoWithdrawalAttempt | undefined,
  next: UptoWithdrawalAttempt,
) {
  const entry = entries.get(requestDigest);
  if (
    !entry ||
    entry.channelId !== channelId ||
    !sameWithdrawal(entry.withdrawal, expected)
  )
    unavailable();
  if (
    next.pending &&
    !expected?.pending &&
    entry.state !== PAYMENT_CHANNEL_STATES.OPEN
  )
    unavailable();
  if (
    expected?.pending &&
    (next.transaction !== expected.transaction ||
      next.step !== expected.step ||
      next.lastValidBlockHeight !== expected.lastValidBlockHeight)
  )
    unavailable();
  if (!expected?.pending && !next.pending) unavailable();
  if (expected && BigInt(next.checkedSlot) < BigInt(expected.checkedSlot))
    unavailable();
  entries.set(requestDigest, { ...entry, withdrawal: next });
}

export function withdrawalWriter(
  mutate: (
    change: (entries: Map<string, UptoJournalEntry>) => void,
  ) => Promise<void>,
): NonNullable<WithdrawalJournal['recordWithdrawal']> {
  return async (digest, channelId, expected, next) => {
    const previous = journalWithdrawal(expected).withdrawal;
    const fixed = journalWithdrawal(next).withdrawal;
    return mutate((entries) => {
      if (!fixed) unavailable();
      recordJournalWithdrawal(entries, digest, channelId, previous, fixed);
    });
  };
}

export function withdrawalCheckpoint(
  journal: UptoBuyerJournal,
  entry: UptoJournalEntry & { channelId: string },
): UptoWithdrawalRecovery {
  const expected = journalWithdrawal(entry.withdrawal).withdrawal;
  const record = journal.recordWithdrawal?.bind(journal);
  const { requestDigest, channelId, state } = entry;
  return {
    previous: journalWithdrawal(expected).withdrawal,
    readOnly: state === PAYMENT_CHANNEL_STATES.SETTLED,
    async save(next) {
      if (!record) unavailable();
      await record(requestDigest, channelId, expected, next);
    },
  };
}
