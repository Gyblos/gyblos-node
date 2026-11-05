// Validates durable sandbox session records before payment work can resume.
// Legacy single-request records must be terminal before a session can start.
import {
  PAYPAL_SANDBOX,
  PAYPAL_SANDBOX_CURRENCIES,
} from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_SESSION_PREVIOUS_RECORD_VERSION,
  PAYPAL_SESSION_RECORD_VERSION,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import { paypalPreviousAttemptFinished } from './paypal-inference';

type Phase = (typeof PHASE)[keyof typeof PHASE];
interface PaypalAgentCompletion {
  messageId: string;
  requestDigest: string;
  idempotencyDigest?: string;
}
interface PaypalSessionRecordBase {
  phase: Phase;
  requestId: string;
  currency: (typeof PAYPAL_SANDBOX_CURRENCIES)[keyof typeof PAYPAL_SANDBOX_CURRENCIES];
  limitCents: number;
  messageCents: number;
  maxMessageAttempts: number;
  spentCents: number;
  attemptIds: string[];
  acknowledgedIds: string[];
  orderId?: string;
  authorizationId?: string;
  expiresAt?: number;
  messageId?: string;
  promptDigest?: string;
  captureId?: string;
  reviewDigest?: string;
}
export type PaypalSessionRecord = PaypalSessionRecordBase &
  (
    | {
        version: typeof PAYPAL_SESSION_PREVIOUS_RECORD_VERSION;
        agentCompletions?: never;
      }
    | {
        version: typeof PAYPAL_SESSION_RECORD_VERSION;
        agentCompletions: PaypalAgentCompletion[];
      }
  );
function fail(
  code: (typeof PAYPAL_ERROR_CODES)[keyof typeof PAYPAL_ERROR_CODES],
): never {
  throw new PaypalError(code);
}
function hasPhase(phase: Phase, values: readonly Phase[]) {
  return values.includes(phase);
}
export function paypalSessionIsTerminal(record: PaypalSessionRecord | null) {
  return (
    !record ||
    hasPhase(record.phase, [PHASE.COMPLETED, PHASE.VOIDED, PHASE.CANCELLED])
  );
}
function idList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isPaypalId) &&
    new Set(value).size === value.length
  );
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function completions(value: unknown): PaypalAgentCompletion[] {
  if (!Array.isArray(value)) return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
    const row = Object.fromEntries(Object.entries(entry));
    if (
      Object.keys(row).some(
        (key) =>
          !['messageId', 'requestDigest', 'idempotencyDigest'].includes(key),
      ) ||
      !isPaypalId(row.messageId) ||
      !digest(row.requestDigest) ||
      (row.idempotencyDigest !== undefined && !digest(row.idempotencyDigest))
    )
      return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
    return {
      messageId: row.messageId,
      requestDigest: row.requestDigest,
      ...(typeof row.idempotencyDigest === 'string'
        ? { idempotencyDigest: row.idempotencyDigest }
        : {}),
    };
  });
}
function validateShape(
  item: Record<string, unknown>,
  phase: Phase,
  spentCents: number,
  limitCents: number,
  messageCents: number,
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
    'currency',
    'limitCents',
    'messageCents',
    'maxMessageAttempts',
    'spentCents',
    'attemptIds',
    'acknowledgedIds',
    'orderId',
    'authorizationId',
    'expiresAt',
    'messageId',
    'promptDigest',
    'captureId',
    'reviewDigest',
    ...(item.version === PAYPAL_SESSION_RECORD_VERSION
      ? ['agentCompletions']
      : []),
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
    (item.reviewDigest !== undefined &&
      (!digest(item.reviewDigest) ||
        !hasPhase(phase, [PHASE.CAPTURING, PHASE.COMPLETED]))) ||
    (phase === PHASE.MESSAGE_PENDING && spentCents < messageCents) ||
    (phase === PHASE.EXECUTING && spentCents + messageCents > limitCents) ||
    (hasPhase(phase, [
      PHASE.CREATING,
      PHASE.CREATED,
      PHASE.REVIEW,
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
function optionalDetails(item: Record<string, unknown>) {
  return {
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
    ...(digest(item.reviewDigest) ? { reviewDigest: item.reviewDigest } : {}),
  };
}
function useNewTerms(
  item: Record<string, unknown>,
  phase: Phase,
  historical: boolean,
) {
  const changed =
    item.currency !== PAYPAL_SANDBOX.currency ||
    item.limitCents !== PAYPAL_SANDBOX.limitCents ||
    item.messageCents !== PAYPAL_SANDBOX.messageCents ||
    item.maxMessageAttempts !== PAYPAL_SANDBOX.maxMessageAttempts;
  if (
    changed &&
    !historical &&
    !hasPhase(phase, [PHASE.COMPLETED, PHASE.VOIDED, PHASE.CANCELLED])
  )
    return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  return changed;
}
function invalidLedger(
  phase: Phase,
  attempts: string[],
  acknowledged: string[],
  agentCompletions: PaypalAgentCompletion[],
  messageId: unknown,
  spentCents: number,
  messageCents: number,
) {
  const agentIds = agentCompletions.map((entry) => entry.messageId);
  const keys = agentCompletions.flatMap((entry) =>
    entry.idempotencyDigest ? [entry.idempotencyDigest] : [],
  );
  return (
    (hasPhase(phase, [
      PHASE.CREATING,
      PHASE.CREATED,
      PHASE.REVIEW,
      PHASE.AUTHORIZING,
      PHASE.CANCELLED,
    ]) &&
      attempts.length !== 0) ||
    acknowledged.some((id) => !attempts.includes(id)) ||
    new Set(agentIds).size !== agentIds.length ||
    new Set(keys).size !== keys.length ||
    agentIds.some(
      (id) => !attempts.includes(id) || acknowledged.includes(id),
    ) ||
    spentCents !==
      (acknowledged.length +
        agentCompletions.length +
        (phase === PHASE.MESSAGE_PENDING ? 1 : 0)) *
        messageCents ||
    (hasPhase(phase, [PHASE.EXECUTING, PHASE.MESSAGE_PENDING]) &&
      (typeof messageId !== 'string' ||
        messageId !== attempts.at(-1) ||
        acknowledged.includes(messageId) ||
        agentIds.includes(messageId)))
  );
}
function versionedRecord(
  common: Omit<PaypalSessionRecord, 'version' | 'agentCompletions'>,
  version: unknown,
  agentCompletions: PaypalAgentCompletion[],
): PaypalSessionRecord {
  return version === PAYPAL_SESSION_PREVIOUS_RECORD_VERSION
    ? { ...common, version: PAYPAL_SESSION_PREVIOUS_RECORD_VERSION }
    : { ...common, version: PAYPAL_SESSION_RECORD_VERSION, agentCompletions };
}
function legacySessionState(value: unknown) {
  return { record: null, legacyBlocked: !paypalPreviousAttemptFinished(value) };
}
function sessionCurrency(value: unknown) {
  return Object.values(PAYPAL_SANDBOX_CURRENCIES).find(
    (currency) => currency === value,
  );
}
function validVersion(value: unknown) {
  return (
    value === PAYPAL_SESSION_RECORD_VERSION ||
    value === PAYPAL_SESSION_PREVIOUS_RECORD_VERSION
  );
}
export function parsePaypalSessionState(
  value: unknown,
  historical = false,
): {
  record: PaypalSessionRecord | null;
  legacyBlocked: boolean;
} {
  if (value === null) return { record: null, legacyBlocked: false };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  const item = Object.fromEntries(Object.entries(value));
  if (item.version === undefined) return legacySessionState(value);
  const phase = Object.values(PHASE).find((entry) => entry === item.phase);
  const currency = sessionCurrency(item.currency);
  const agentCompletions =
    item.version === PAYPAL_SESSION_RECORD_VERSION
      ? completions(item.agentCompletions)
      : [];
  if (
    !validVersion(item.version) ||
    !currency ||
    !Number.isSafeInteger(item.limitCents) ||
    item.limitCents < 1 ||
    !Number.isSafeInteger(item.messageCents) ||
    item.messageCents < 1 ||
    item.messageCents > item.limitCents ||
    !Number.isSafeInteger(item.maxMessageAttempts) ||
    item.maxMessageAttempts < 1 ||
    !phase ||
    !isPaypalId(item.requestId) ||
    typeof item.spentCents !== 'number' ||
    !Number.isSafeInteger(item.spentCents) ||
    item.spentCents < 0 ||
    item.spentCents > item.limitCents ||
    item.spentCents % item.messageCents !== 0 ||
    !idList(item.attemptIds) ||
    !idList(item.acknowledgedIds) ||
    item.attemptIds.length > item.maxMessageAttempts ||
    invalidLedger(
      phase,
      item.attemptIds,
      item.acknowledgedIds,
      agentCompletions,
      item.messageId,
      item.spentCents,
      item.messageCents,
    )
  )
    return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  validateShape(
    item,
    phase,
    item.spentCents,
    item.limitCents,
    item.messageCents,
  );
  if (
    useNewTerms(item, phase, historical) &&
    !historical &&
    !digest(item.reviewDigest)
  ) {
    return { record: null, legacyBlocked: false };
  }
  const common = {
    phase,
    requestId: item.requestId,
    currency,
    limitCents: item.limitCents,
    messageCents: item.messageCents,
    maxMessageAttempts: item.maxMessageAttempts,
    spentCents: item.spentCents,
    attemptIds: item.attemptIds,
    acknowledgedIds: item.acknowledgedIds,
    ...optionalDetails(item),
  };
  return {
    record: versionedRecord(common, item.version, agentCompletions),
    legacyBlocked: false,
  };
}
