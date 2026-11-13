// Formats observed local session state without inventing transaction dates or capture outcomes.
import { PAYPAL_SESSION_PHASE as PHASE } from '@gyblos/node/constants';

import type { ActivityEntry } from '../activity-model';

export function sessionOutcome(entry: ActivityEntry) {
  if (entry.needsReview) return 'Needs review';
  if (entry.capturedCents !== null) return 'Payment captured';
  if (entry.phase === PHASE.COMPLETED) return 'Capture unconfirmed';
  if (entry.phase === PHASE.VOIDED) return 'Authorization voided';
  if (entry.phase === PHASE.CANCELLED) return 'Checkout cancelled';
  if (entry.phase === PHASE.MESSAGE_PENDING) return 'Response unconfirmed';
  if (entry.phase === PHASE.ACTIVE) return 'Session open';
  return 'Awaiting approval';
}
export function activityDate(value: number) {
  if (!Number.isFinite(new Date(value).getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}
