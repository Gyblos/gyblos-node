// Coordinates one sandbox purchase with one bounded inference; the payment and engine are injected.
// The journal contains only payment metadata and a prompt digest, never prompts or responses.
import { createHash, randomUUID } from 'node:crypto';

import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  isPaypalId,
  PaypalError,
  type PaypalSandboxPayment,
} from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_PHASE as PHASE,
  PAYPAL_REQUEST_LIMITS as REQUEST_LIMITS,
} from './constants';

type Phase = (typeof PHASE)[keyof typeof PHASE];

interface Attempt {
  phase: Phase;
  promptDigest: string;
  requestId: string;
  maxTokens: number;
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
}

export interface PaypalInferenceDependencies {
  validateRequest?(prompt: string, maxTokens: number): void;
  payment: PaypalSandboxPayment;
  journal: {
    read(): Promise<unknown>;
    write(value: Attempt): Promise<void>;
  };
  engine: {
    generate(input: {
      prompt: string;
      maxTokens: number;
      signal?: AbortSignal;
    }): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }>;
  };
}

function parseAttempt(value: unknown): Attempt | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  const entry = Object.fromEntries(Object.entries(value));
  if (
    !Object.values(PHASE).some((phase) => phase === entry.phase) ||
    typeof entry.promptDigest !== 'string' ||
    !isPaypalId(entry.requestId) ||
    !/^[a-f0-9]{64}$/.test(entry.promptDigest) ||
    !Number.isSafeInteger(entry.maxTokens) ||
    typeof entry.maxTokens !== 'number' ||
    entry.maxTokens < 1 ||
    entry.maxTokens > REQUEST_LIMITS.maxTokens ||
    ['orderId', 'authorizationId', 'captureId'].some(
      (key) => entry[key] !== undefined && !isPaypalId(entry[key]),
    )
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  const phase = Object.values(PHASE).find((item) => item === entry.phase);
  if (!phase) throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  if (
    (phase !== PHASE.CREATING && typeof entry.orderId !== 'string') ||
    ([
      PHASE.EXECUTING,
      PHASE.CAPTURING,
      PHASE.COMPLETED,
      PHASE.VOIDING,
      PHASE.VOIDED,
      PHASE.REFUNDING,
      PHASE.REFUNDED,
    ].some((item) => item === phase) &&
      typeof entry.authorizationId !== 'string') ||
    ([PHASE.COMPLETED, PHASE.REFUNDING, PHASE.REFUNDED].some(
      (item) => item === phase,
    ) &&
      typeof entry.captureId !== 'string')
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_JOURNAL);
  return {
    phase,
    requestId: entry.requestId,
    promptDigest: entry.promptDigest,
    maxTokens: entry.maxTokens,
    ...(typeof entry.orderId === 'string' ? { orderId: entry.orderId } : {}),
    ...(typeof entry.authorizationId === 'string'
      ? { authorizationId: entry.authorizationId }
      : {}),
    ...(typeof entry.captureId === 'string'
      ? { captureId: entry.captureId }
      : {}),
  };
}

function digest(prompt: string, maxTokens: number): string {
  if (
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    Buffer.byteLength(prompt, 'utf8') > REQUEST_LIMITS.promptBytes ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > REQUEST_LIMITS.maxTokens
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  return createHash('sha256')
    .update(JSON.stringify({ prompt, maxTokens }))
    .digest('hex');
}

async function generateOrVoid(
  deps: PaypalInferenceDependencies,
  save: (attempt: Attempt) => Promise<void>,
  authorized: Attempt,
  authorizationId: string,
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
) {
  try {
    signal?.throwIfAborted();
    const output = await deps.engine.generate({ prompt, maxTokens, signal });
    signal?.throwIfAborted();
    return output;
  } catch {
    await save({ ...authorized, phase: PHASE.VOIDING });
    await deps.payment.void(authorizationId);
    await save({ ...authorized, phase: PHASE.VOIDED });
    throw new PaypalError(PAYPAL_ERROR_CODES.INFERENCE_FAILED);
  }
}

function isFinished(attempt: Attempt | null) {
  return (
    !attempt ||
    attempt.phase === PHASE.COMPLETED ||
    attempt.phase === PHASE.VOIDED ||
    attempt.phase === PHASE.REFUNDED ||
    attempt.phase === PHASE.CANCELLED
  );
}

class PaypalInference {
  private busy = false;
  private journalFailed = false;
  constructor(
    private readonly deps: PaypalInferenceDependencies,
    private active: Attempt | null,
  ) {}

  private async save(attempt: Attempt) {
    this.active = attempt;
    try {
      await this.deps.journal.write(attempt);
    } catch (error) {
      this.journalFailed = true;
      throw error;
    }
  }
  async cancel() {
    if (
      this.busy ||
      this.journalFailed ||
      !this.active ||
      this.active.phase !== PHASE.CREATED
    )
      throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    this.busy = true;
    try {
      await this.save({ ...this.active, phase: PHASE.CANCELLED });
    } finally {
      this.busy = false;
    }
  }
  async create(prompt: string, maxTokens: number) {
    const promptDigest = digest(prompt, maxTokens);
    if (this.busy || this.journalFailed || !isFinished(this.active))
      throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    this.busy = true;
    try {
      this.deps.validateRequest?.(prompt, maxTokens);
      await this.deps.payment.prepare?.();
      const requestId = randomUUID();
      await this.save({
        phase: PHASE.CREATING,
        requestId,
        promptDigest,
        maxTokens,
      });
      const order = await this.deps.payment.create(requestId);
      await this.save({
        phase: PHASE.CREATED,
        requestId,
        promptDigest,
        maxTokens,
        orderId: order.orderId,
      });
      return order;
    } finally {
      this.busy = false;
    }
  }
  async execute(
    orderId: string,
    prompt: string,
    maxTokens: number,
    signal?: AbortSignal,
  ) {
    const promptDigest = digest(prompt, maxTokens);
    if (
      this.busy ||
      this.journalFailed ||
      !this.active ||
      this.active.phase !== PHASE.CREATED ||
      this.active.orderId !== orderId ||
      this.active.promptDigest !== promptDigest ||
      this.active.maxTokens !== maxTokens
    )
      throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.busy = true;
    try {
      const attempt = this.active;
      if (
        this.deps.payment.isApproved &&
        !(await this.deps.payment.isApproved(orderId))
      )
        throw new PaypalError(PAYPAL_ERROR_CODES.NOT_APPROVED);
      signal?.throwIfAborted();
      await this.save({ ...attempt, phase: PHASE.AUTHORIZING });
      const authorization = await this.deps.payment.authorize(orderId);
      const authorized = {
        ...attempt,
        ...authorization,
        phase: PHASE.EXECUTING,
      };
      await this.save(authorized);
      const output = await generateOrVoid(
        this.deps,
        (item) => this.save(item),
        authorized,
        authorization.authorizationId,
        prompt,
        maxTokens,
        signal,
      );
      await this.save({ ...authorized, phase: PHASE.CAPTURING });
      const capture = await this.deps.payment.capture(
        authorization.authorizationId,
      );
      if (signal?.aborted) {
        await this.save({ ...authorized, ...capture, phase: PHASE.REFUNDING });
        if (!this.deps.payment.refund)
          throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
        await this.deps.payment.refund(capture.captureId);
        await this.save({ ...authorized, ...capture, phase: PHASE.REFUNDED });
        throw new PaypalError(PAYPAL_ERROR_CODES.REFUNDED);
      }
      await this.save({ ...authorized, ...capture, phase: PHASE.COMPLETED });
      return output;
    } finally {
      this.busy = false;
    }
  }
}

export async function createPaypalInference(deps: PaypalInferenceDependencies) {
  return new PaypalInference(deps, parseAttempt(await deps.journal.read()));
}
