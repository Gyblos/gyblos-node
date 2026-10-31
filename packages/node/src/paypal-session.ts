// Coordinates one sandbox authorization and a bounded sequence of independent inferences.
// The durable journal contains payment metadata only; ambiguous effects remain blocked.
import { createHash, randomUUID } from 'node:crypto';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_REQUEST_LIMITS,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import {
  paypalPreviousAttemptFinished,
  type PaypalInferenceDependencies,
} from './paypal-inference';

type Phase = (typeof PHASE)[keyof typeof PHASE];
export interface PaypalSessionRecord {
  version: 2;
  phase: Phase;
  requestId: string;
  spentCents: number;
  orderId?: string;
  authorizationId?: string;
  expiresAt?: number;
  messageId?: string;
  promptDigest?: string;
  captureId?: string;
}
export interface PaypalSessionDependencies {
  payment: PaypalInferenceDependencies['payment'];
  engine: PaypalInferenceDependencies['engine'];
  validateRequest?: PaypalInferenceDependencies['validateRequest'];
  journal: {
    read(): Promise<unknown>;
    write(value: PaypalSessionRecord): Promise<void>;
  };
}

function fail(
  code: (typeof PAYPAL_ERROR_CODES)[keyof typeof PAYPAL_ERROR_CODES],
): never {
  throw new PaypalError(code);
}
function hasPhase(phase: Phase, values: readonly Phase[]) {
  return values.includes(phase);
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
function parse(value: unknown): {
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
    item.spentCents % PAYPAL_SANDBOX.messageCents !== 0
  )
    return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  validateShape(item, phase, item.spentCents);
  return {
    record: {
      version: 2,
      phase,
      requestId: item.requestId,
      spentCents: item.spentCents,
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
function promptDigest(prompt: string, maxTokens: number) {
  if (
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    Buffer.byteLength(prompt, 'utf8') > PAYPAL_REQUEST_LIMITS.promptBytes ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > PAYPAL_REQUEST_LIMITS.maxTokens
  )
    return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  return createHash('sha256')
    .update(JSON.stringify({ prompt, maxTokens }))
    .digest('hex');
}
function terminal(record: PaypalSessionRecord | null) {
  return (
    !record ||
    hasPhase(record.phase, [PHASE.COMPLETED, PHASE.VOIDED, PHASE.CANCELLED])
  );
}

class PaypalSession {
  private busy = false;
  private journalFailed = false;
  constructor(
    private readonly deps: PaypalSessionDependencies,
    private active: PaypalSessionRecord | null,
    private readonly legacyBlocked: boolean,
  ) {}
  private async save(value: PaypalSessionRecord) {
    this.active = value;
    try {
      await this.deps.journal.write(value);
    } catch (error) {
      this.journalFailed = true;
      throw error;
    }
  }
  private check(phase: Phase) {
    if (
      this.busy ||
      this.journalFailed ||
      this.legacyBlocked ||
      !this.active ||
      this.active.phase !== phase
    )
      return fail(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    return this.active;
  }
  status() {
    return {
      phase: this.active?.phase ?? (this.legacyBlocked ? 'blocked' : 'ready'),
      spentCents: this.active?.spentCents ?? 0,
      limitCents: PAYPAL_SANDBOX.limitCents,
      messageCents: PAYPAL_SANDBOX.messageCents,
    };
  }
  async create() {
    if (
      this.busy ||
      this.journalFailed ||
      this.legacyBlocked ||
      !terminal(this.active)
    )
      return fail(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    this.busy = true;
    try {
      await this.deps.payment.prepare?.();
      const record: PaypalSessionRecord = {
        version: 2,
        phase: PHASE.CREATING,
        requestId: randomUUID(),
        spentCents: 0,
      };
      await this.save(record);
      const order = await this.deps.payment.create(record.requestId);
      await this.save({
        ...record,
        phase: PHASE.CREATED,
        orderId: order.orderId,
      });
      return order;
    } finally {
      this.busy = false;
    }
  }
  async cancel() {
    const record = this.check(PHASE.CREATED);
    this.busy = true;
    try {
      await this.save({ ...record, phase: PHASE.CANCELLED });
    } finally {
      this.busy = false;
    }
  }
  async approve(orderId: string) {
    const record = this.check(PHASE.CREATED);
    if (record.orderId !== orderId)
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.busy = true;
    try {
      if (!this.deps.payment.isApproved)
        return fail(PAYPAL_ERROR_CODES.INVALID_CONFIG);
      if (!(await this.deps.payment.isApproved(orderId)))
        return fail(PAYPAL_ERROR_CODES.NOT_APPROVED);
      await this.save({ ...record, phase: PHASE.AUTHORIZING });
      const authorization = await this.deps.payment.authorize(orderId);
      await this.save({
        ...record,
        ...authorization,
        phase: PHASE.ACTIVE,
        expiresAt: Date.now() + PAYPAL_SANDBOX.sessionMs,
      });
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  async message(prompt: string, maxTokens: number, signal?: AbortSignal) {
    const digest = promptDigest(prompt, maxTokens);
    const record = this.check(PHASE.ACTIVE);
    if (
      !record.expiresAt ||
      Date.now() >= record.expiresAt ||
      record.spentCents + PAYPAL_SANDBOX.messageCents >
        PAYPAL_SANDBOX.limitCents
    )
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.deps.validateRequest?.(prompt, maxTokens);
    this.busy = true;
    try {
      signal?.throwIfAborted();
      const messageId = randomUUID();
      await this.save({
        ...record,
        phase: PHASE.EXECUTING,
        messageId,
        promptDigest: digest,
      });
      let output: Awaited<
        ReturnType<PaypalSessionDependencies['engine']['generate']>
      >;
      try {
        output = await this.deps.engine.generate({ prompt, maxTokens, signal });
        signal?.throwIfAborted();
      } catch {
        await this.save(record);
        return fail(PAYPAL_ERROR_CODES.INFERENCE_FAILED);
      }
      await this.save({
        ...record,
        phase: PHASE.MESSAGE_PENDING,
        messageId,
        promptDigest: digest,
        spentCents: record.spentCents + PAYPAL_SANDBOX.messageCents,
      });
      return { ...output, messageId };
    } finally {
      this.busy = false;
    }
  }
  async acknowledge(messageId: string) {
    const record = this.check(PHASE.MESSAGE_PENDING);
    if (record.messageId !== messageId)
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.busy = true;
    try {
      const {
        messageId: _messageId,
        promptDigest: _promptDigest,
        ...remaining
      } = record;
      await this.save({ ...remaining, phase: PHASE.ACTIVE });
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  async finish() {
    const record = this.check(PHASE.ACTIVE);
    if (!record.authorizationId)
      return fail(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
    this.busy = true;
    try {
      if (record.spentCents === 0) {
        await this.save({ ...record, phase: PHASE.VOIDING });
        await this.deps.payment.void(record.authorizationId);
        await this.save({ ...record, phase: PHASE.VOIDED });
      } else {
        await this.save({ ...record, phase: PHASE.CAPTURING });
        const capture = await this.deps.payment.capture(
          record.authorizationId,
          record.spentCents,
        );
        await this.save({ ...record, ...capture, phase: PHASE.COMPLETED });
      }
      return this.status();
    } finally {
      this.busy = false;
    }
  }
}
export async function createPaypalSession(deps: PaypalSessionDependencies) {
  const state = parse(await deps.journal.read());
  return new PaypalSession(deps, state.record, state.legacyBlocked);
}
