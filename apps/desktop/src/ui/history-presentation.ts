// Pure local-history selection and financial summaries. Never performs payments or invents records.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

import type { ActivityEntry } from '../activity-model';
import type { PaypalPaymentReference } from '../payment-reference-model';
import { sessionOutcome } from './activity-presentation';
import {
  HISTORY,
  HISTORY_METHOD,
  HISTORY_PERIOD,
  HISTORY_SOURCE,
  type HistoryMethod,
  type HistoryPeriod,
  type HistorySource,
} from './history-constants';

export {
  HISTORY_METHOD,
  HISTORY_PERIOD,
  HISTORY_SOURCE,
} from './history-constants';
export type HistoryFilter = {
  method: HistoryMethod;
  period: HistoryPeriod;
  source: HistorySource;
  query: string;
  now: number;
};
export function sourceCents(entry: ActivityEntry, source: HistorySource) {
  return source === HISTORY_SOURCE.CHAT
    ? entry.chatCents
    : source === HISTORY_SOURCE.AGENTS
      ? entry.agentCents
      : entry.recordedCents;
}
export function filterHistory(
  entries: readonly ActivityEntry[],
  filter: HistoryFilter,
  references: readonly PaypalPaymentReference[] = [],
) {
  if (filter.method === HISTORY_METHOD.USDC) return [];
  const days =
    filter.period === HISTORY_PERIOD.WEEK
      ? HISTORY.WEEK_DAYS
      : HISTORY.MONTH_DAYS;
  const after =
    filter.period === HISTORY_PERIOD.ALL
      ? 0
      : filter.now - days * HISTORY.DAY_MS;
  const query = filter.query.trim().toLowerCase();
  return entries
    .filter(
      (entry) =>
        entry.updatedAt >= after &&
        (filter.source === HISTORY_SOURCE.ALL ||
          sourceCents(entry, filter.source) > 0) &&
        `${entry.id} ${sessionOutcome(entry)} ${references.find((reference) => reference.sessionId === entry.id)?.id ?? ''}`
          .toLowerCase()
          .includes(query),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
}
export function financialSummary(
  entries: readonly ActivityEntry[],
  source: HistorySource,
) {
  let paid: number | null = 0;
  let pending: number | null = 0;
  let payments = 0;
  for (const entry of entries) {
    const uncertain =
      entry.needsReview ||
      (entry.phase === PAYPAL_SESSION_PHASE.COMPLETED &&
        entry.capturedCents === null);
    if (uncertain) {
      paid = null;
      pending = null;
    }
    if (entry.capturedCents !== null) {
      payments += 1;
      if (paid !== null) paid += sourceCents(entry, source);
    } else if (
      pending !== null &&
      ![PAYPAL_SESSION_PHASE.VOIDED, PAYPAL_SESSION_PHASE.CANCELLED].some(
        (phase) => phase === entry.phase,
      )
    )
      pending += sourceCents(entry, source);
  }
  return { paid, pending, payments };
}
export function referenceHeading(method: HistoryMethod) {
  return method === HISTORY_METHOD.USDC
    ? 'Tx hash'
    : method === HISTORY_METHOD.PAYPAL
      ? 'Payment ID'
      : 'Reference';
}
export function shortReference(value: string) {
  return value.length > HISTORY.REFERENCE_LENGTH
    ? value.slice(0, HISTORY.REFERENCE_PREFIX) +
        '…' +
        value.slice(-HISTORY.REFERENCE_SUFFIX)
    : value;
}
