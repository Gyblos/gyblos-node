// Classifies signed journal entries by network before recovery; legacy entries remain unbound.
import {
  UPTO_SOLANA_NAMESPACE,
  UPTO_SOLANA_REFERENCE_LENGTH,
} from 'x402-upto-metered';

import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import type { UptoBuyerJournal, UptoJournalEntry } from './buyer-journal';
import {
  NETWORK_RECOVERY_BLOCKS,
  type NetworkRecoveryBlock,
} from './constants';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function isJournalNetwork(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const [namespace, reference, ...rest] = value.split(':');
  return (
    namespace === UPTO_SOLANA_NAMESPACE &&
    rest.length === 0 &&
    reference?.length === UPTO_SOLANA_REFERENCE_LENGTH &&
    BASE58.test(reference)
  );
}

export function checkJournalNetwork(network: string): void {
  if (!isJournalNetwork(network))
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
}

export function networkRecoveryBlock(
  entry: UptoJournalEntry,
  network: string,
): NetworkRecoveryBlock | undefined {
  const recorded = entry.policy?.network ?? null;
  if (recorded === null) return NETWORK_RECOVERY_BLOCKS.UNKNOWN;
  return recorded === network ? undefined : NETWORK_RECOVERY_BLOCKS.MISMATCH;
}

// Keep caller-supplied method references stable throughout asynchronous recovery.
export function snapshotJournal(journal: UptoBuyerJournal): UptoBuyerJournal {
  return {
    get: journal.get.bind(journal),
    put: journal.put.bind(journal),
    remove: journal.remove.bind(journal),
    list: journal.list.bind(journal),
    close: journal.close.bind(journal),
  };
}
