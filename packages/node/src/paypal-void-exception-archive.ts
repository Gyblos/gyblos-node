// Checks an interrupted-void exception archive without asserting capture history.
// Missing or contradictory private evidence seals the sandbox journal.
import { createHash } from 'node:crypto';

import { paypalSandboxVoidExceptionPath } from '@gyblos/config/home';
import { canonicalJson } from '@gyblos/protocol';
import { readPrivateFile } from '@gyblos/runtime/private-file';

import {
  PAYPAL_SESSION_JOURNAL_MAX_BYTES,
  PAYPAL_VOID_EXCEPTION,
  PAYPAL_VOID_EXCEPTION_ENVELOPE_MAX_BYTES,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import {
  parsePaypalSessionState,
  type PaypalSessionRecord,
} from './paypal-session-record';

const MAX_BYTES =
  PAYPAL_SESSION_JOURNAL_MAX_BYTES + PAYPAL_VOID_EXCEPTION_ENVELOPE_MAX_BYTES;
function historyObservation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = Object.fromEntries(Object.entries(value));
  if (
    Object.keys(item).sort().join(',') !==
      [
        'source',
        'windowStart',
        'windowEnd',
        'lastRefreshed',
        'pages',
        'balanceAffectingOnly',
        'events',
      ]
        .sort()
        .join(',') ||
    item.source !== PAYPAL_VOID_EXCEPTION.HISTORY_SOURCE ||
    typeof item.windowStart !== 'string' ||
    !Number.isFinite(Date.parse(item.windowStart)) ||
    typeof item.windowEnd !== 'string' ||
    !Number.isFinite(Date.parse(item.windowEnd)) ||
    typeof item.lastRefreshed !== 'string' ||
    !Number.isFinite(Date.parse(item.lastRefreshed)) ||
    Date.parse(item.windowStart) > Date.parse(item.windowEnd) ||
    !Number.isSafeInteger(item.pages) ||
    typeof item.pages !== 'number' ||
    item.pages < 1 ||
    item.balanceAffectingOnly !== false ||
    !Array.isArray(item.events) ||
    item.events.length > PAYPAL_VOID_EXCEPTION.MAX_HISTORY_EVENTS
  )
    return false;
  return item.events.every((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false;
    const event = Object.fromEntries(Object.entries(value));
    return (
      Object.keys(event).sort().join(',') ===
        [
          'code',
          'status',
          'isAuthorization',
          'referencesAuthorization',
          'isObservedMovement',
          'amount',
          'currency',
        ]
          .sort()
          .join(',') &&
      typeof event.code === 'string' &&
      /^T\d{4}$/.test(event.code) &&
      typeof event.status === 'string' &&
      /^[DPSV]$/.test(event.status) &&
      typeof event.isAuthorization === 'boolean' &&
      typeof event.referencesAuthorization === 'boolean' &&
      typeof event.isObservedMovement === 'boolean' &&
      typeof event.amount === 'string' &&
      /^\d{1,9}\.\d{2}$/.test(event.amount) &&
      event.currency === 'USD'
    );
  });
}
export async function paypalVoidExceptionIsSealed(
  root: string,
  record: PaypalSessionRecord,
) {
  try {
    const text = await readPrivateFile(
      paypalSandboxVoidExceptionPath(root, record.requestId),
      MAX_BYTES,
    );
    if (text === undefined) return record.voidReviewDigest !== undefined;
    if (!record.voidReviewDigest) return true;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return true;
    const archive = Object.fromEntries(Object.entries(parsed));
    if (
      Object.keys(archive).sort().join(',') !==
        [
          'version',
          'decision',
          'decisionSource',
          'decisionScope',
          'history',
          'externalOperations',
          'recordedUsageCents',
          'providerAuthorization',
          'historyEvidence',
          'recordedAt',
          'previous',
        ]
          .sort()
          .join(',') ||
      archive.version !== PAYPAL_VOID_EXCEPTION.VERSION ||
      archive.decision !== PAYPAL_VOID_EXCEPTION.DECISION ||
      archive.decisionSource !== PAYPAL_VOID_EXCEPTION.DECISION_SOURCE ||
      archive.decisionScope !== PAYPAL_VOID_EXCEPTION.DECISION_SCOPE ||
      archive.history !== PAYPAL_VOID_EXCEPTION.UNKNOWN ||
      archive.externalOperations !== PAYPAL_VOID_EXCEPTION.UNKNOWN ||
      archive.recordedUsageCents !== 0 ||
      archive.providerAuthorization !==
        PAYPAL_VOID_EXCEPTION.AUTHORIZATION_VOIDED ||
      !historyObservation(archive.historyEvidence) ||
      !Number.isSafeInteger(archive.recordedAt) ||
      typeof archive.recordedAt !== 'number' ||
      archive.recordedAt <= 0
    )
      return true;
    const prior = parsePaypalSessionState(archive.previous, true);
    if (
      prior.legacyBlocked ||
      !prior.record ||
      prior.record.phase !== PHASE.VOIDING ||
      prior.record.spentCents !== 0 ||
      canonicalJson(prior.record) !== canonicalJson(archive.previous)
    )
      return true;
    const digest = createHash('sha256')
      .update(canonicalJson(archive))
      .digest('hex');
    return (
      record.voidReviewDigest !== digest ||
      canonicalJson(record) !==
        canonicalJson({
          ...prior.record,
          phase: PHASE.VOIDED,
          voidReviewDigest: digest,
        })
    );
  } catch {
    return true;
  }
}
