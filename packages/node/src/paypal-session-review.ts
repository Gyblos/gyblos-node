// Settles an explicitly waived uncertain sandbox inference without accepting another inference.
// The private journal and payment adapter supply the exclusive review capabilities.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@gyblos/protocol';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaypalError,
  type PaypalSandboxPayment,
} from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_SESSION_REVIEW_ACTOR,
  PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
  PAYPAL_SESSION_REVIEW_DECISION,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import type { PaypalSessionRecord } from './paypal-session-record';

export interface PaypalWaiverArchive {
  version: typeof PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION;
  decision: typeof PAYPAL_SESSION_REVIEW_DECISION.WAIVE_UNCERTAIN;
  actor: typeof PAYPAL_SESSION_REVIEW_ACTOR.LOCAL_OPERATOR;
  decidedAt: number;
  verifiedAt: number;
  session: PaypalSessionRecord;
}
export interface PaypalWaiverOutcome {
  version: typeof PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION;
  decisionDigest: string;
  amountCents: number;
  captureId: string;
  completedAt: number;
}
export interface PaypalReviewJournal {
  archiveWaiver(value: PaypalWaiverArchive): Promise<string>;
  archiveOutcome(value: PaypalWaiverOutcome): Promise<void>;
  write(value: PaypalSessionRecord): Promise<void>;
}
export interface PaypalSessionJournal {
  claimSession?(): PaypalSessionJournal;
  startExecution?(): () => void;
  isReviewSealed?(): boolean;
  read(): Promise<unknown>;
  write(value: PaypalSessionRecord): Promise<void>;
  review?(
    action: (journal: PaypalReviewJournal) => Promise<void>,
  ): Promise<void>;
}
function fingerprint(record: PaypalSessionRecord) {
  return createHash('sha256')
    .update('paypal-uncertain-review-v1:')
    .update(
      canonicalJson({
        orderId: record.orderId,
        requestId: record.requestId,
        authorizationId: record.authorizationId,
        messageId: record.messageId,
        promptDigest: record.promptDigest,
        spentCents: record.spentCents,
      }),
    )
    .digest('hex');
}
export function paypalReviewTicket(record: PaypalSessionRecord) {
  return { fingerprint: fingerprint(record), spentCents: record.spentCents };
}
interface ReviewInput {
  record: PaypalSessionRecord;
  orderId: string;
  confirmedCents: number;
  fingerprint: string;
  decidedAt: number;
  exclusiveJournal: boolean;
  payment: PaypalSandboxPayment;
  journal: PaypalSessionJournal;
  save(
    value: PaypalSessionRecord,
    write: PaypalReviewJournal['write'],
  ): Promise<void>;
}
export async function settlePaypalReviewedInference(input: ReviewInput) {
  const { record, orderId, confirmedCents } = input;
  const authorizationId = record.authorizationId;
  const beginReview = input.payment.beginReview?.bind(input.payment);
  const review = input.journal.review?.bind(input.journal);
  if (
    record.orderId !== orderId ||
    !authorizationId ||
    !Number.isSafeInteger(confirmedCents) ||
    confirmedCents <= 0 ||
    confirmedCents !== record.spentCents ||
    input.fingerprint !== fingerprint(record) ||
    !Number.isSafeInteger(input.decidedAt) ||
    input.decidedAt <= 0 ||
    input.decidedAt > Date.now() ||
    !input.exclusiveJournal ||
    !beginReview ||
    !review
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
  await review(async (journal) => {
    const lease = await beginReview(orderId, record.requestId, authorizationId);
    try {
      const decisionDigest = await journal.archiveWaiver({
        version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
        decision: PAYPAL_SESSION_REVIEW_DECISION.WAIVE_UNCERTAIN,
        actor: PAYPAL_SESSION_REVIEW_ACTOR.LOCAL_OPERATOR,
        decidedAt: input.decidedAt,
        verifiedAt: Date.now(),
        session: record,
      });
      const {
        messageId: _messageId,
        promptDigest: _promptDigest,
        ...remaining
      } = record;
      await input.save(
        { ...remaining, reviewDigest: decisionDigest, phase: PHASE.CAPTURING },
        journal.write,
      );
      const capture = await lease.capture(confirmedCents);
      await journal.archiveOutcome({
        version: PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION,
        decisionDigest,
        amountCents: confirmedCents,
        captureId: capture.captureId,
        completedAt: Date.now(),
      });
      await input.save(
        {
          ...remaining,
          ...capture,
          reviewDigest: decisionDigest,
          phase: PHASE.COMPLETED,
        },
        journal.write,
      );
    } finally {
      lease.release();
    }
  });
}
