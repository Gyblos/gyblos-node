// Sandbox payment port for one direct merchant; it carries no chain or engine dependencies.
import {
  PAYPAL_ERROR_CODES,
  PAYPAL_ID_PATTERN,
  PAYPAL_RETURN_STATE_PATTERN,
} from './constants';

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

export function isPaypalReturnState(value: unknown): value is string {
  return typeof value === 'string' && PAYPAL_RETURN_STATE_PATTERN.test(value);
}

export interface PaypalSandboxReviewLease {
  capture(cents: number): Promise<{ captureId: string }>;
  release(): void;
}
export interface PaypalSandboxPayment {
  prepare?(): Promise<void>;
  discardApproval?(): void;
  isApproved?(
    orderId: string,
    requestId: string,
    limitCents?: number,
  ): Promise<boolean>;
  checkVoidedAuthorization?(
    orderId: string,
    requestId: string,
    authorizationId: string,
    limitCents?: number,
  ): Promise<void>;
  beginReview?(
    orderId: string,
    requestId: string,
    authorizationId: string,
    limitCents?: number,
  ): Promise<PaypalSandboxReviewLease>;
  create(
    requestId: string,
    returnState?: string,
    limitCents?: number,
  ): Promise<{ orderId: string; approvalUrl: string }>;
  authorize(
    orderId: string,
    requestId: string,
    limitCents?: number,
  ): Promise<{ authorizationId: string }>;
  capture(
    authorizationId: string,
    cents?: number,
  ): Promise<{ captureId: string }>;
  void(authorizationId: string, limitCents?: number): Promise<void>;
  refund?(captureId: string): Promise<void>;
}
