// Shared input and status helpers for the local sandbox session.
// This module performs no payment, journal or inference operations.
import { createHash } from 'node:crypto';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { PAYPAL_REQUEST_LIMITS, PAYPAL_SESSION_STATUS } from './constants';
import type { PaypalInferenceDependencies } from './paypal-inference';
import type { PaypalSessionRecord } from './paypal-session-record';
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
