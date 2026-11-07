// Session terms, status, restored-authorization checks and guarded capture.
// Inference and session lifecycle remain in the coordinating service.
import { createHash } from 'node:crypto';

import {
  PAYPAL_SANDBOX,
  PAYPAL_SANDBOX_LIMIT_OPTIONS,
} from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  isPaypalReturnState,
  PaypalError,
} from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_REQUEST_LIMITS,
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_RECORD_VERSION,
  PAYPAL_SESSION_STATUS,
  PAYPAL_SESSION_VARIABLE_RECORD_VERSION,
} from './constants';
import type { PaypalInferenceDependencies } from './paypal-inference';
import {
  paypalSessionIsTerminal,
  type PaypalSessionRecord,
} from './paypal-session-record';
import type { PaypalSessionJournal } from './paypal-session-review';

export interface PaypalSessionDependencies {
  payment: PaypalInferenceDependencies['payment'];
  engine: PaypalInferenceDependencies['engine'];
  validateRequest?: PaypalInferenceDependencies['validateRequest'];
  agentEngine?: {
    model: string;
    validate?(input: unknown): void;
    generate(input: unknown, signal?: AbortSignal): Promise<unknown>;
  };
  journal: PaypalSessionJournal;
}
export function validatePaypalSessionTerms(
  returnState: string | undefined,
  limitCents: number,
) {
  if (
    !PAYPAL_SANDBOX_LIMIT_OPTIONS.some((limit) => limit === limitCents) ||
    (returnState !== undefined && !isPaypalReturnState(returnState))
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
}
export function paypalRestorationVerifier(
  active: PaypalSessionRecord | null,
  payment: PaypalSessionDependencies['payment'],
) {
  let pending =
    active?.version === PAYPAL_SESSION_VARIABLE_RECORD_VERSION &&
    !paypalSessionIsTerminal(active) &&
    active.authorizationId !== undefined;
  return async (record: PaypalSessionRecord) => {
    if (!pending) return;
    if (record.requestId !== active?.requestId) {
      pending = false;
      return;
    }
    await verifyRestoredPaypalAuthorization(record, payment);
    pending = false;
  };
}
export function newPaypalSessionRecord(
  requestId: string,
  limitCents: number,
): PaypalSessionRecord {
  return {
    version:
      limitCents === PAYPAL_SANDBOX.limitCents
        ? PAYPAL_SESSION_RECORD_VERSION
        : PAYPAL_SESSION_VARIABLE_RECORD_VERSION,
    phase: PAYPAL_SESSION_PHASE.CREATING,
    requestId,
    currency: PAYPAL_SANDBOX.currency,
    limitCents,
    messageCents: PAYPAL_SANDBOX.messageCents,
    maxMessageAttempts:
      limitCents / PAYPAL_SANDBOX.messageCents +
      (PAYPAL_SANDBOX.maxMessageAttempts -
        PAYPAL_SANDBOX.limitCents / PAYPAL_SANDBOX.messageCents),
    spentCents: 0,
    attemptIds: [],
    acknowledgedIds: [],
    agentCompletions: [],
  };
}
export async function verifyRestoredPaypalAuthorization(
  record: PaypalSessionRecord,
  payment: PaypalSessionDependencies['payment'],
) {
  if (!record.orderId || !record.authorizationId || !payment.beginReview)
    throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
  const lease = await payment.beginReview(
    record.orderId,
    record.requestId,
    record.authorizationId,
    record.limitCents,
  );
  lease.release();
}
export async function capturePaypalSession(
  record: PaypalSessionRecord,
  payment: PaypalSessionDependencies['payment'],
  saveCapturing: () => Promise<void>,
) {
  if (!record.authorizationId)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  if (record.version !== PAYPAL_SESSION_VARIABLE_RECORD_VERSION) {
    await saveCapturing();
    return payment.capture(record.authorizationId, record.spentCents);
  }
  if (!record.orderId || !payment.beginReview)
    throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
  const lease = await payment.beginReview(
    record.orderId,
    record.requestId,
    record.authorizationId,
    record.limitCents,
  );
  try {
    await saveCapturing();
    return await lease.capture(record.spentCents);
  } finally {
    lease.release();
  }
}
export function paypalPromptDigest(prompt: string, maxTokens: number) {
  if (
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    Buffer.byteLength(prompt, 'utf8') > PAYPAL_REQUEST_LIMITS.promptBytes ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > PAYPAL_REQUEST_LIMITS.maxTokens
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  return createHash('sha256')
    .update(JSON.stringify({ prompt, maxTokens }))
    .digest('hex');
}
export function paypalSessionStatus(
  active: PaypalSessionRecord | null,
  journalFailed: boolean,
  legacyBlocked: boolean,
) {
  return {
    phase:
      journalFailed || legacyBlocked
        ? PAYPAL_SESSION_STATUS.BLOCKED
        : (active?.phase ?? PAYPAL_SESSION_STATUS.READY),
    spentCents: active?.spentCents ?? 0,
    limitCents: active?.limitCents ?? PAYPAL_SANDBOX.limitCents,
    messageCents: active?.messageCents ?? PAYPAL_SANDBOX.messageCents,
    orderId: active?.orderId,
    remainingAttempts:
      (active?.maxMessageAttempts ?? PAYPAL_SANDBOX.maxMessageAttempts) -
      (active?.attemptIds.length ?? 0),
    expired: active?.expiresAt !== undefined && Date.now() >= active.expiresAt,
  };
}
