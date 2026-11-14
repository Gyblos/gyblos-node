// Projects private buyer-session accounting into read-only, identifier-free activity.
import { createHash } from 'node:crypto';

import {
  PAYPAL_SESSION_STATUS,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import type { PaypalSessionRecord } from './paypal-session-record';

export function paypalSessionActivity(
  record: PaypalSessionRecord | null,
  status: {
    phase:
      | PaypalSessionRecord['phase']
      | (typeof PAYPAL_SESSION_STATUS)[keyof typeof PAYPAL_SESSION_STATUS];
  },
) {
  if (!record) return null;
  const blocked = status.phase === PAYPAL_SESSION_STATUS.BLOCKED;
  const chatCount = record.acknowledgedIds.length;
  const agentCount = record.agentCompletions?.length ?? 0;
  const chatCents = chatCount * record.messageCents;
  const agentCents = agentCount * record.messageCents;
  return {
    id: createHash('sha256').update(record.requestId).digest('hex'),
    phase: record.phase,
    limitCents: record.limitCents,
    recordedCents: record.spentCents,
    chatCount,
    agentCount,
    chatCents,
    agentCents,
    unconfirmedCents: record.spentCents - chatCents - agentCents,
    capturedCents:
      !blocked && record.phase === PHASE.COMPLETED && record.captureId
        ? record.spentCents
        : null,
    needsReview:
      blocked ||
      [
        PHASE.CREATING,
        PHASE.REVIEW,
        PHASE.EXECUTING,
        PHASE.CAPTURING,
        PHASE.AUTHORIZING,
        PHASE.VOIDING,
      ].some((phase) => record.phase === phase),
  };
}
