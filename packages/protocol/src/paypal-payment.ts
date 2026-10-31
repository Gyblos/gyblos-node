// Sandbox payment port for one direct merchant; it carries no chain or engine dependencies.
import { PAYPAL_ERROR_CODES, PAYPAL_ID_PATTERN } from './constants';

export type PaypalErrorCode =
  (typeof PAYPAL_ERROR_CODES)[keyof typeof PAYPAL_ERROR_CODES];
export class PaypalError extends Error {
  constructor(readonly code: PaypalErrorCode) {
    super(code);
    this.name = 'PaypalError';
  }
}

export function isPaypalId(value: unknown): value is string {
  return typeof value === 'string' && PAYPAL_ID_PATTERN.test(value);
}

export interface PaypalSandboxPayment {
  prepare?(): Promise<void>;
  isApproved?(orderId: string): Promise<boolean>;
  create(requestId: string): Promise<{ orderId: string; approvalUrl: string }>;
  authorize(orderId: string): Promise<{ authorizationId: string }>;
  capture(
    authorizationId: string,
    cents?: number,
  ): Promise<{ captureId: string }>;
  void(authorizationId: string): Promise<void>;
  refund?(captureId: string): Promise<void>;
}
