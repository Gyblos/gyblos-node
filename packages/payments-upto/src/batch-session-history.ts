// Flat, bounded closed generations retain financial proof and spent authority without recursive journals.
import { canonicalJson } from '@gyblos/protocol';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import type { BatchGeneration, BatchRecord } from './batch-session-types';
import { BATCH_BLOCK_STATE, BATCH_RENEWAL_STATE } from './constants';

export function sameBatchParties(
  previous: PaymentSessionTerms,
  next: PaymentSessionTerms,
) {
  return (
    canonicalJson({
      ...previous,
      depositAtomic: next.depositAtomic,
      expiresAt: next.expiresAt,
    }) === canonicalJson(next)
  );
}

export function parseBatchHistory(
  value: unknown,
  terms: PaymentSessionTerms,
  parse: (raw: unknown, terms: unknown) => BatchRecord,
): BatchGeneration[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > BATCH_RENEWAL_STATE.maxHistory
  )
    return sessionFail();
  const channels = new Set<string>();
  let expiresAt = -1;
  return value.map((raw: unknown) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('version' in raw) ||
      (raw.version !== PAYMENT_SESSION.version &&
        raw.version !== BATCH_BLOCK_STATE.version) ||
      !('terms' in raw)
    )
      return sessionFail();
    const entry = parse(raw, raw.terms);
    if (
      entry.state !== SESSION_STATES.CLOSED ||
      !entry.settlement ||
      !entry.channelId ||
      channels.has(entry.channelId) ||
      entry.terms.expiresAt <= expiresAt ||
      entry.terms.expiresAt >= terms.expiresAt ||
      !sameBatchParties(entry.terms, terms)
    )
      return sessionFail(SESSION_CODES.BINDING);
    expiresAt = entry.terms.expiresAt;
    channels.add(entry.channelId);
    return { ...entry, version: raw.version };
  });
}
