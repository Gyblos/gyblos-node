// Coordinates one sandbox authorization and a bounded sequence of independent inferences.
// The durable journal contains payment metadata only; ambiguous effects remain blocked.
import { createHash, randomUUID } from 'node:crypto';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_AGENT_REQUEST_LIMITS,
  PAYPAL_REQUEST_LIMITS,
  PAYPAL_SESSION_RECORD_VERSION,
  PAYPAL_SESSION_PHASE as PHASE,
  PAYPAL_SESSION_STATUS as STATUS,
} from './constants';
import {
  validatePaypalAgentRequest,
  validatePaypalAgentResult,
} from './paypal-agent-validation';
import type { PaypalInferenceDependencies } from './paypal-inference';
import {
  parsePaypalSessionState,
  type PaypalSessionRecord,
} from './paypal-session-record';

export type { PaypalSessionRecord } from './paypal-session-record';
type Phase = (typeof PHASE)[keyof typeof PHASE];

export interface PaypalSessionDependencies {
  payment: PaypalInferenceDependencies['payment'];
  engine: PaypalInferenceDependencies['engine'];
  validateRequest?: PaypalInferenceDependencies['validateRequest'];
  agentEngine?: {
    model: string;
    validate?(input: unknown): void;
    generate(input: unknown, signal?: AbortSignal): Promise<unknown>;
  };
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
function agentRequest(input: unknown, model: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized, 'utf8') >
      PAYPAL_AGENT_REQUEST_LIMITS.requestBytes
  )
    return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  const normalized = validatePaypalAgentRequest(value, model);
  const normalizedBytes = JSON.stringify(normalized);
  return {
    input: normalized,
    digest: createHash('sha256')
      .update(PAYPAL_AGENT_REQUEST_LIMITS.digestDomain)
      .update(normalizedBytes)
      .digest('hex'),
  };
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
      phase:
        this.journalFailed || this.legacyBlocked
          ? STATUS.BLOCKED
          : (this.active?.phase ?? STATUS.READY),
      spentCents: this.active?.spentCents ?? 0,
      limitCents: PAYPAL_SANDBOX.limitCents,
      messageCents: PAYPAL_SANDBOX.messageCents,
      orderId: this.active?.orderId,
      remainingAttempts:
        PAYPAL_SANDBOX.maxMessageAttempts -
        (this.active?.attemptIds.length ?? 0),
      expired:
        this.active?.expiresAt !== undefined &&
        Date.now() >= this.active.expiresAt,
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
        version: PAYPAL_SESSION_RECORD_VERSION,
        phase: PHASE.CREATING,
        requestId: randomUUID(),
        currency: PAYPAL_SANDBOX.currency,
        limitCents: PAYPAL_SANDBOX.limitCents,
        messageCents: PAYPAL_SANDBOX.messageCents,
        maxMessageAttempts: PAYPAL_SANDBOX.maxMessageAttempts,
        spentCents: 0,
        attemptIds: [],
        acknowledgedIds: [],
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
  async cancel(orderId: string) {
    const record = this.check(PHASE.CREATED);
    if (record.orderId !== orderId)
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
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
  private async runMessage<T>(
    orderId: string,
    messageId: string,
    digest: string,
    generate: () => Promise<T>,
    validate: () => void,
    signal: AbortSignal | undefined,
  ) {
    const record = this.check(PHASE.ACTIVE);
    if (
      record.orderId !== orderId ||
      !record.expiresAt ||
      Date.now() >= record.expiresAt ||
      !isPaypalId(messageId) ||
      record.attemptIds.includes(messageId) ||
      record.attemptIds.length >= PAYPAL_SANDBOX.maxMessageAttempts ||
      record.spentCents + PAYPAL_SANDBOX.messageCents >
        PAYPAL_SANDBOX.limitCents
    )
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.busy = true;
    try {
      validate();
      signal?.throwIfAborted();
      const attemptIds = [...record.attemptIds, messageId];
      await this.save({
        ...record,
        phase: PHASE.EXECUTING,
        attemptIds,
        messageId,
        promptDigest: digest,
      });
      if (signal?.aborted) {
        await this.save({ ...record, attemptIds });
        return fail(PAYPAL_ERROR_CODES.INFERENCE_FAILED);
      }
      let output: T;
      try {
        output = await generate();
        signal?.throwIfAborted();
      } catch {
        return fail(PAYPAL_ERROR_CODES.INFERENCE_FAILED);
      }
      await this.save({
        ...record,
        phase: PHASE.MESSAGE_PENDING,
        attemptIds,
        messageId,
        promptDigest: digest,
        spentCents: record.spentCents + PAYPAL_SANDBOX.messageCents,
      });
      if (signal?.aborted) {
        await this.save({ ...record, attemptIds });
        return fail(PAYPAL_ERROR_CODES.INFERENCE_FAILED);
      }
      return { output, messageId };
    } finally {
      this.busy = false;
    }
  }
  async message(
    orderId: string,
    prompt: string,
    maxTokens: number,
    messageId: string,
    signal?: AbortSignal,
  ) {
    const digest = promptDigest(prompt, maxTokens);
    const result = await this.runMessage(
      orderId,
      messageId,
      digest,
      () => this.deps.engine.generate({ prompt, maxTokens, signal }),
      () => this.deps.validateRequest?.(prompt, maxTokens),
      signal,
    );
    return { ...result.output, messageId: result.messageId };
  }
  async agentMessage(
    orderId: string,
    input: unknown,
    messageId: string,
    signal?: AbortSignal,
  ) {
    const engine = this.deps.agentEngine;
    if (!engine) return fail(PAYPAL_ERROR_CODES.INVALID_CONFIG);
    const request = agentRequest(input, engine.model);
    const maxTokens = request.input.max_tokens;
    if (typeof maxTokens !== 'number')
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    const result = await this.runMessage(
      orderId,
      messageId,
      request.digest,
      async () =>
        validatePaypalAgentResult(
          await engine.generate(request.input, signal),
          engine.model,
          maxTokens,
          request.input,
        ),
      () => engine.validate?.(request.input),
      signal,
    );
    return { response: result.output, messageId: result.messageId };
  }
  async acknowledge(orderId: string, messageId: string) {
    if (
      !this.busy &&
      !this.journalFailed &&
      !this.legacyBlocked &&
      this.active?.phase === PHASE.ACTIVE &&
      this.active.orderId === orderId &&
      this.active.acknowledgedIds.includes(messageId)
    )
      return this.status();
    const record = this.check(PHASE.MESSAGE_PENDING);
    if (record.orderId !== orderId || record.messageId !== messageId)
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.busy = true;
    try {
      const {
        messageId: _messageId,
        promptDigest: _promptDigest,
        ...remaining
      } = record;
      await this.save({
        ...remaining,
        phase: PHASE.ACTIVE,
        acknowledgedIds: [...record.acknowledgedIds, messageId],
      });
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  async finish(orderId: string) {
    const record = this.check(PHASE.ACTIVE);
    if (record.orderId !== orderId)
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
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
  const state = parsePaypalSessionState(await deps.journal.read());
  return new PaypalSession(deps, state.record, state.legacyBlocked);
}
