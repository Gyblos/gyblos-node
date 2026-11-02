// Refuses cross-network recovery before RPC, reporting, or withdrawal; legacy entries are devnet-only.
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';
import {
  UPTO_SOLANA_NAMESPACE,
  UPTO_SOLANA_REFERENCE_LENGTH,
} from 'x402-upto-metered';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import type { UptoJournalEntry } from './buyer-journal';

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

export function checkJournalNetwork(
  entries: UptoJournalEntry[],
  network: string,
): void {
  if (!isJournalNetwork(network))
    throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  for (const entry of entries) {
    if (!entry.channelId || entry.state !== PAYMENT_CHANNEL_STATES.OPEN)
      continue;
    const recorded = entry.policy?.network ?? null;
    if (
      recorded === null ? network !== SOLANA_DEVNET_CAIP2 : recorded !== network
    )
      throw new PaymentError(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  }
}
