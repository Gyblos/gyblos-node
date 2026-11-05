// Validates private sandbox review evidence and decides whether an unfinished review seals the journal.
// It never stores prompts, model responses, credentials or provider bodies.
import { createHash } from 'node:crypto';

import { paypalSandboxReviewPaths } from '@gyblos/config/home';
import { canonicalJson } from '@gyblos/protocol';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';
import { readPrivateFile } from '@gyblos/runtime/private-file';

import {
  PAYPAL_SESSION_REVIEW_ACTOR,
  PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
  PAYPAL_SESSION_REVIEW_DECISION,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import {
  parsePaypalSessionState,
  type PaypalSessionRecord,
} from './paypal-session-record';
import type {
  PaypalWaiverArchive,
  PaypalWaiverOutcome,
} from './paypal-session-review';

export const PAYPAL_REVIEW_MAX_BYTES = 9216;
export function paypalReviewFailure(): never {
  throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
}
function exactKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',')
  );
}
export function paypalArchiveDigest(value: PaypalWaiverArchive) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function parsePaypalWaiverArchive(value: unknown): PaypalWaiverArchive {
  if (
    !exactKeys(value, [
      'version',
      'decision',
      'actor',
      'decidedAt',
      'verifiedAt',
      'session',
    ]) ||
    value.version !== PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION ||
    value.decision !== PAYPAL_SESSION_REVIEW_DECISION.WAIVE_UNCERTAIN ||
    value.actor !== PAYPAL_SESSION_REVIEW_ACTOR.LOCAL_OPERATOR ||
    typeof value.decidedAt !== 'number' ||
    !Number.isSafeInteger(value.decidedAt) ||
    value.decidedAt <= 0 ||
    typeof value.verifiedAt !== 'number' ||
    !Number.isSafeInteger(value.verifiedAt) ||
    value.verifiedAt <= 0
  )
    return paypalReviewFailure();
  const state = parsePaypalSessionState(value.session, true);
  if (
    state.legacyBlocked ||
    !state.record ||
    state.record.phase !== PHASE.EXECUTING
  )
    return paypalReviewFailure();
  return {
    version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
    decision: PAYPAL_SESSION_REVIEW_DECISION.WAIVE_UNCERTAIN,
    actor: PAYPAL_SESSION_REVIEW_ACTOR.LOCAL_OPERATOR,
    decidedAt: value.decidedAt,
    verifiedAt: value.verifiedAt,
    session: state.record,
  };
}
export function parsePaypalWaiverOutcome(
  value: unknown,
  archive: PaypalWaiverArchive,
): PaypalWaiverOutcome {
  if (
    !exactKeys(value, [
      'version',
      'decisionDigest',
      'amountCents',
      'captureId',
      'completedAt',
    ]) ||
    value.version !== PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION ||
    value.decisionDigest !== paypalArchiveDigest(archive) ||
    value.amountCents !== archive.session.spentCents ||
    !isPaypalId(value.captureId) ||
    typeof value.completedAt !== 'number' ||
    !Number.isSafeInteger(value.completedAt) ||
    value.completedAt <= 0
  )
    return paypalReviewFailure();
  return {
    version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
    decisionDigest: value.decisionDigest,
    amountCents: value.amountCents,
    captureId: value.captureId,
    completedAt: value.completedAt,
  };
}
export function paypalPostReviewState(
  archive: PaypalWaiverArchive,
  captureId?: string,
) {
  const {
    messageId: _messageId,
    promptDigest: _promptDigest,
    ...remaining
  } = archive.session;
  const reviewDigest = paypalArchiveDigest(archive);
  return captureId
    ? { ...remaining, reviewDigest, phase: PHASE.COMPLETED, captureId }
    : { ...remaining, reviewDigest, phase: PHASE.CAPTURING };
}
export async function paypalReviewIsSealed(
  root: string,
  record: PaypalSessionRecord,
) {
  const paths = paypalSandboxReviewPaths(root, record.requestId);
  const decision = await readPrivateFile(
    paths.decision,
    PAYPAL_REVIEW_MAX_BYTES,
  );
  const result = await readPrivateFile(paths.outcome, PAYPAL_REVIEW_MAX_BYTES);
  if (decision === undefined)
    return result !== undefined || record.reviewDigest !== undefined;
  const archive = parsePaypalWaiverArchive(JSON.parse(decision));
  if (record.reviewDigest !== paypalArchiveDigest(archive)) return true;
  if (record.phase !== PHASE.COMPLETED || result === undefined) return true;
  const outcome = parsePaypalWaiverOutcome(JSON.parse(result), archive);
  return (
    canonicalJson(record) !==
    canonicalJson(paypalPostReviewState(archive, outcome.captureId))
  );
}
