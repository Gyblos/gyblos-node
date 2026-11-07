// Coordinates sandbox inference and accounting; ambiguous payments stay blocked.
import { randomUUID } from 'node:crypto';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_SESSION_PREVIOUS_RECORD_VERSION,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import {
  checkAgentOperation,
  completedAgentRecord,
  type AgentOperation,
} from './paypal-agent-billing';
import {
  paypalAgentIdempotencyDigest,
  preparePaypalAgentRequest,
  validatePaypalAgentResult,
} from './paypal-agent-validation';
import { paypalSessionActivity } from './paypal-session-activity';
import {
  parsePaypalSessionState,
  paypalSessionIsTerminal,
  type PaypalSessionRecord,
} from './paypal-session-record';
import {
  paypalReviewTicket,
  settlePaypalReviewedInference,
} from './paypal-session-review';
import {
  capturePaypalSession,
  newPaypalSessionRecord,
  paypalPromptDigest,
  paypalRestorationVerifier,
  paypalSessionStatus,
  validatePaypalSessionTerms,
  type PaypalSessionDependencies,
} from './paypal-session-support';
import { checkVoid, fail } from './paypal-session-void-check';

export type { PaypalSessionRecord } from './paypal-session-record';
export type { PaypalReviewJournal } from './paypal-session-review';
export type { PaypalWaiverArchive } from './paypal-session-review';
export type { PaypalSessionDependencies } from './paypal-session-support';
class PaypalSession {
  private busy = false;
  private journalFailed = false;
  private readonly verifyRestored: ReturnType<typeof paypalRestorationVerifier>;
  constructor(
    private readonly deps: PaypalSessionDependencies,
    private active: PaypalSessionRecord | null,
    private readonly legacyBlocked: boolean,
    private readonly exclusive: boolean,
  ) {
    this.verifyRestored = paypalRestorationVerifier(active, deps.payment);
  }
  private get unavailable() {
    return (
      this.busy ||
      this.journalFailed ||
      this.legacyBlocked ||
      this.deps.journal.isReviewSealed?.() === true
    );
  }
  private async save(
    value: PaypalSessionRecord,
    write?: (value: PaypalSessionRecord) => Promise<void>,
  ) {
    this.active = value;
    try {
      if (write) await write(value);
      else await this.deps.journal.write(value);
    } catch (error) {
      this.journalFailed = true;
      throw error;
    }
  }
  private async interruptApproval(record: PaypalSessionRecord): Promise<never> {
    this.deps.payment.discardApproval?.();
    await this.save(record);
    return fail(PAYPAL_ERROR_CODES.INTERRUPTED);
  }
  private check(phase: PaypalSessionRecord['phase']) {
    if (this.unavailable || !this.active || this.active.phase !== phase)
      return fail(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    return this.active;
  }
  status() {
    return paypalSessionStatus(
      this.active,
      this.journalFailed,
      this.legacyBlocked || this.deps.journal.isReviewSealed?.() === true,
    );
  }
  activity = () => paypalSessionActivity(this.active, this.status());
  checkVoidedAuthorization = () =>
    checkVoid(this.check(PHASE.VOIDING), this.deps, this.exclusive, (busy) => {
      this.busy = busy;
    });
  async create(returnState?: string, limitCents?: number) {
    limitCents ??= PAYPAL_SANDBOX.limitCents;
    validatePaypalSessionTerms(returnState, limitCents);
    if (this.unavailable || !paypalSessionIsTerminal(this.active))
      return fail(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    this.busy = true;
    try {
      const { payment } = this.deps;
      await payment.prepare?.();
      const record = newPaypalSessionRecord(randomUUID(), limitCents);
      await this.save(record);
      const { requestId } = record;
      const order = await payment.create(requestId, returnState, limitCents);
      const { orderId } = order;
      await this.save({ ...record, phase: PHASE.CREATED, orderId });
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
  async approve(
    orderId: string,
    mayAuthorize?: () => boolean,
    onDispatch?: () => void,
  ) {
    const record = this.check(PHASE.CREATED);
    if (record.orderId !== orderId)
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.busy = true;
    try {
      const { payment } = this.deps;
      if (!payment.isApproved) return fail(PAYPAL_ERROR_CODES.INVALID_CONFIG);
      await this.save({ ...record, phase: PHASE.REVIEW });
      if (mayAuthorize && !mayAuthorize())
        return await this.interruptApproval(record);
      const approved = await payment.isApproved(
        orderId,
        record.requestId,
        record.limitCents,
      );
      if (mayAuthorize && !mayAuthorize())
        return await this.interruptApproval(record);
      if (!approved) {
        await this.save(record);
        return fail(PAYPAL_ERROR_CODES.NOT_APPROVED);
      }
      await this.save({ ...record, phase: PHASE.AUTHORIZING });
      if (mayAuthorize && !mayAuthorize())
        return await this.interruptApproval(record);
      onDispatch?.();
      const authorization = await payment.authorize(
        orderId,
        record.requestId,
        record.limitCents,
      );
      await this.save({
        ...record,
        ...authorization,
        phase: PHASE.ACTIVE,
        expiresAt: Date.now() + PAYPAL_SANDBOX.sessionMs,
      });
      return this.status();
    } finally {
      try {
        this.deps.payment.discardApproval?.();
      } finally {
        this.busy = false;
      }
    }
  }
  private async runMessage<T>(
    orderId: string,
    messageId: string,
    digest: string,
    generate: () => Promise<T>,
    validate: () => void,
    signal: AbortSignal | undefined,
    agent?: AgentOperation,
  ) {
    const record = this.check(PHASE.ACTIVE);
    if (
      record.orderId !== orderId ||
      !record.expiresAt ||
      Date.now() >= record.expiresAt ||
      !isPaypalId(messageId) ||
      record.attemptIds.includes(messageId) ||
      record.attemptIds.length >= record.maxMessageAttempts ||
      record.spentCents + PAYPAL_SANDBOX.messageCents > record.limitCents
    )
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.busy = true;
    let finishExecution = () => {};
    try {
      await this.verifyRestored(record);
      if (!record.expiresAt || Date.now() >= record.expiresAt)
        return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
      finishExecution = this.deps.journal.startExecution?.() ?? finishExecution;
      if (agent) checkAgentOperation(record, digest, agent);
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
        if (!agent) signal?.throwIfAborted();
      } catch {
        return fail(PAYPAL_ERROR_CODES.INFERENCE_FAILED);
      }
      if (agent && record.version !== PAYPAL_SESSION_PREVIOUS_RECORD_VERSION) {
        await this.save(
          completedAgentRecord(record, attemptIds, messageId, digest, agent),
        );
        return { output, messageId };
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
      finishExecution();
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
    const digest = paypalPromptDigest(prompt, maxTokens);
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
    idempotencyKey?: string,
  ) {
    const engine = this.deps.agentEngine;
    if (!engine) return fail(PAYPAL_ERROR_CODES.INVALID_CONFIG);
    const request = preparePaypalAgentRequest(input, engine.model);
    const keyDigest = paypalAgentIdempotencyDigest(idempotencyKey);
    const maxTokens = request.input.max_tokens;
    if (typeof maxTokens !== 'number')
      return fail(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    const result = await this.runMessage(
      orderId,
      messageId,
      request.digest,
      async () =>
        validatePaypalAgentResult(
          await engine.generate(request.input),
          engine.model,
          maxTokens,
          request.input,
        ),
      () => engine.validate?.(request.input),
      signal,
      {
        ...(keyDigest ? { idempotencyDigest: keyDigest } : {}),
        equivalentDigests: request.equivalentDigests,
      },
    );
    return { response: result.output, messageId: result.messageId };
  }
  async acknowledge(orderId: string, messageId: string) {
    if (
      !this.unavailable &&
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
      await this.verifyRestored(record);
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
      await this.verifyRestored(record);
      if (record.spentCents === 0) {
        await this.save({ ...record, phase: PHASE.VOIDING });
        await this.deps.payment.void(record.authorizationId, record.limitCents);
        await this.save({ ...record, phase: PHASE.VOIDED });
      } else {
        const capture = await capturePaypalSession(
          record,
          this.deps.payment,
          () => this.save({ ...record, phase: PHASE.CAPTURING }),
        );
        await this.save({ ...record, ...capture, phase: PHASE.COMPLETED });
      }
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  reviewTicket = () => paypalReviewTicket(this.check(PHASE.EXECUTING));
  async settleReviewedInference(
    orderId: string,
    confirmedCents: number,
    fingerprint: string,
    decidedAt: number,
  ) {
    const record = this.check(PHASE.EXECUTING);
    this.busy = true;
    try {
      await settlePaypalReviewedInference({
        record,
        orderId,
        confirmedCents,
        fingerprint,
        decidedAt,
        exclusiveJournal: this.exclusive,
        payment: this.deps.payment,
        journal: this.deps.journal,
        save: (value, write) => this.save(value, write),
      });
      return this.status();
    } finally {
      this.busy = false;
    }
  }
}
export async function createPaypalSession(deps: PaypalSessionDependencies) {
  const owned = deps.journal.claimSession?.();
  const journal = owned ?? deps.journal;
  const state = parsePaypalSessionState(await journal.read());
  return new PaypalSession(
    { ...deps, journal },
    state.record,
    state.legacyBlocked,
    owned !== undefined,
  );
}
