// Validates durable sandbox session records before payment work can resume.
// Legacy single-request records must be terminal before a session can start.
import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';

import { PAYPAL_SESSION_PHASE as PHASE } from './constants';
import { paypalPreviousAttemptFinished } from './paypal-inference';

type Phase = (typeof PHASE)[keyof typeof PHASE];
export interface PaypalSessionRecord {
  version: 2;
  phase: Phase;
  requestId: string;
  spentCents: number;
  attemptIds: string[];
  acknowledgedIds: string[];
  orderId?: string;
  authorizationId?: string;
  expiresAt?: number;
  messageId?: string;
  promptDigest?: string;
  captureId?: string;
}
function fail(
  code: (typeof PAYPAL_ERROR_CODES)[keyof typeof PAYPAL_ERROR_CODES],
): never {
  throw new PaypalError(code);
}
function hasPhase(phase: Phase, values: readonly Phase[]) {
  return values.includes(phase);
}
function idList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isPaypalId) &&
    new Set(value).size === value.length
  );
}
function validateShape(
  item: Record<string, unknown>,
  phase: Phase,
  spentCents: number,
) {
  const order = phase !== PHASE.CREATING;
  const authorized = hasPhase(phase, [
    PHASE.ACTIVE,
    PHASE.EXECUTING,
    PHASE.MESSAGE_PENDING,
    PHASE.CAPTURING,
    PHASE.COMPLETED,
    PHASE.VOIDING,
    PHASE.VOIDED,
  ]);
  const message = hasPhase(phase, [PHASE.EXECUTING, PHASE.MESSAGE_PENDING]);
  const captured = phase === PHASE.COMPLETED;
  const validKeys = [
    'version',
    'phase',
    'requestId',
    'spentCents',
    'attemptIds',
    'acknowledgedIds',
    'orderId',
    'authorizationId',
    'expiresAt',
    'messageId',
    'promptDigest',
    'captureId',
  ];
  if (
    Object.keys(item).some((key) => !validKeys.includes(key)) ||
    isPaypalId(item.orderId) !== order ||
    (item.orderId !== undefined && !order) ||
    isPaypalId(item.authorizationId) !== authorized ||
    (item.authorizationId !== undefined && !authorized) ||
    (typeof item.expiresAt === 'number' &&
      Number.isSafeInteger(item.expiresAt) &&
      item.expiresAt > 0) !== authorized ||
    (item.expiresAt !== undefined && !authorized) ||
    isPaypalId(item.messageId) !== message ||
    (item.messageId !== undefined && !message) ||
    (typeof item.promptDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(item.promptDigest)) !== message ||
    (item.promptDigest !== undefined && !message) ||
    isPaypalId(item.captureId) !== captured ||
    (item.captureId !== undefined && !captured) ||
    (phase === PHASE.MESSAGE_PENDING &&
      spentCents < PAYPAL_SANDBOX.messageCents) ||
    (phase === PHASE.EXECUTING &&
      spentCents + PAYPAL_SANDBOX.messageCents > PAYPAL_SANDBOX.limitCents) ||
    (hasPhase(phase, [
      PHASE.CREATING,
      PHASE.CREATED,
      PHASE.AUTHORIZING,
      PHASE.CANCELLED,
      PHASE.VOIDING,
      PHASE.VOIDED,
    ]) &&
      spentCents !== 0) ||
    (hasPhase(phase, [PHASE.CAPTURING, PHASE.COMPLETED]) && spentCents === 0)
  )
    return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
}
export function parsePaypalSessionState(value: unknown): {
  record: PaypalSessionRecord | null;
  legacyBlocked: boolean;
} {
  if (value === null) return { record: null, legacyBlocked: false };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  const item = Object.fromEntries(Object.entries(value));
  if (item.version === undefined)
    return {
      record: null,
      legacyBlocked: !paypalPreviousAttemptFinished(value),
    };
  const phase = Object.values(PHASE).find((entry) => entry === item.phase);
  if (
    item.version !== 2 ||
    !phase ||
    !isPaypalId(item.requestId) ||
    typeof item.spentCents !== 'number' ||
    !Number.isSafeInteger(item.spentCents) ||
    item.spentCents < 0 ||
    item.spentCents > PAYPAL_SANDBOX.limitCents ||
    item.spentCents % PAYPAL_SANDBOX.messageCents !== 0 ||
    !idList(item.attemptIds) ||
    !idList(item.acknowledgedIds) ||
    item.attemptIds.length > PAYPAL_SANDBOX.maxMessageAttempts ||
    item.acknowledgedIds.some((id) => !item.attemptIds.includes(id)) ||
    item.spentCents !==
      (item.acknowledgedIds.length +
        (phase === PHASE.MESSAGE_PENDING ? 1 : 0)) *
        PAYPAL_SANDBOX.messageCents ||
    (hasPhase(phase, [PHASE.EXECUTING, PHASE.MESSAGE_PENDING]) &&
      (item.messageId !== item.attemptIds.at(-1) ||
        item.acknowledgedIds.includes(item.messageId)))
  )
    return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  validateShape(item, phase, item.spentCents);
  return {
    record: {
      version: 2,
      phase,
      requestId: item.requestId,
      spentCents: item.spentCents,
      attemptIds: item.attemptIds,
      acknowledgedIds: item.acknowledgedIds,
      ...(isPaypalId(item.orderId) ? { orderId: item.orderId } : {}),
      ...(isPaypalId(item.authorizationId)
        ? { authorizationId: item.authorizationId }
        : {}),
      ...(typeof item.expiresAt === 'number'
        ? { expiresAt: item.expiresAt }
        : {}),
      ...(isPaypalId(item.messageId) ? { messageId: item.messageId } : {}),
      ...(typeof item.promptDigest === 'string'
        ? { promptDigest: item.promptDigest }
        : {}),
      ...(isPaypalId(item.captureId) ? { captureId: item.captureId } : {}),
    },
    legacyBlocked: false,
  };
}
