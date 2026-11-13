// Coordinates a single reviewed sandbox capture and excludes other calls through this adapter.
// The provider remains authoritative; this local lease cannot lock other merchant clients.
import { PAYPAL_SANDBOX_LIMIT_OPTIONS } from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_API,
  PAYPAL_AUTHORIZATION_STATUS,
  PAYPAL_ORDER_INTENT,
  PAYPAL_ORDER_STATUS,
} from './constants';
import type { transport } from './transport';
import { createVoidChecker } from './void-check';

function fail(): never {
  throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return Object.fromEntries(Object.entries(value));
}
function matchesAmount(value: unknown, limitCents: number) {
  const amount = object(value);
  return (
    amount.currency_code === PAYPAL_API.price.currency_code &&
    amount.value === (limitCents / PAYPAL_API.centsPerDollar).toFixed(2)
  );
}
async function verifyUncaptured(
  get: ReturnType<typeof transport>['get'],
  orderId: string,
  requestId: string,
  authorizationId: string,
  limitCents: number,
) {
  if (
    ![orderId, requestId, authorizationId].every(isPaypalId) ||
    !PAYPAL_SANDBOX_LIMIT_OPTIONS.some((limit) => limit === limitCents)
  )
    return fail();
  const order = object((await get(`/v2/checkout/orders/${orderId}`)).value);
  if (
    order.id !== orderId ||
    order.status !== PAYPAL_ORDER_STATUS.COMPLETED ||
    order.intent !== PAYPAL_ORDER_INTENT.AUTHORIZE ||
    !Array.isArray(order.purchase_units) ||
    order.purchase_units.length !== 1
  )
    return fail();
  const unit = object(order.purchase_units[0]);
  if (unit.custom_id !== requestId || !matchesAmount(unit.amount, limitCents))
    return fail();
  const payments = object(unit.payments);
  for (const name of ['captures', 'refunds']) {
    const values = payments[name];
    if (values !== undefined && (!Array.isArray(values) || values.length !== 0))
      return fail();
  }
  if (
    !Array.isArray(payments.authorizations) ||
    payments.authorizations.length !== 1
  )
    return fail();
  const authorization = object(payments.authorizations[0]);
  if (
    authorization.id !== authorizationId ||
    authorization.status !== PAYPAL_AUTHORIZATION_STATUS.CREATED ||
    !matchesAmount(authorization.amount, limitCents)
  )
    return fail();
  const current = object(
    (await get(`/v2/payments/authorizations/${authorizationId}`)).value,
  );
  if (
    current.id !== authorizationId ||
    current.status !== PAYPAL_AUTHORIZATION_STATUS.CREATED ||
    !matchesAmount(current.amount, limitCents)
  )
    return fail();
}

function assertReviewable(
  uncertain: boolean,
  reviewed: Set<string>,
  id?: string,
) {
  if (uncertain || (id && reviewed.has(id)))
    throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
}
type ReviewAccessOptions = {
  get: ReturnType<typeof transport>['get'];
  validateCapture(
    authorizationId: string,
    cents?: number,
    limitCents?: number,
  ): void;
  capture(
    authorizationId: string,
    cents: number,
    limitCents?: number,
  ): Promise<{ captureId: string }>;
  invalidate(): void;
};
export function createPaypalReviewAccess(options: ReviewAccessOptions) {
  const state = { reviewing: false, inFlight: 0 };
  let uncertain = false;
  const reviewedAuthorizations = new Set<string>();
  async function operation<T>(
    run: () => Promise<T>,
    authorizationId?: string,
    isCapture = false,
  ): Promise<T> {
    assertReviewable(uncertain, reviewedAuthorizations, authorizationId);
    if (state.reviewing) throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
    state.inFlight += 1;
    if (isCapture && authorizationId)
      reviewedAuthorizations.add(authorizationId);
    try {
      return await run();
    } catch (error) {
      if (isCapture) uncertain = true;
      throw error;
    } finally {
      state.inFlight -= 1;
    }
  }
  async function beginReview(
    orderId: string,
    requestId: string,
    authorizationId: string,
    limitCents: number = PAYPAL_API.limitCents,
  ) {
    assertReviewable(uncertain, reviewedAuthorizations, authorizationId);
    if (state.reviewing || state.inFlight > 0)
      throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
    state.reviewing = true;
    options.invalidate();
    try {
      await verifyUncaptured(
        options.get,
        orderId,
        requestId,
        authorizationId,
        limitCents,
      );
    } catch (error) {
      state.reviewing = false;
      throw error;
    }
    let closed = false;
    let used = false;
    let capturing = false;
    return {
      async capture(cents: number) {
        if (closed || used) throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
        options.validateCapture(authorizationId, cents, limitCents);
        if (cents > limitCents)
          throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
        used = true;
        reviewedAuthorizations.add(authorizationId);
        capturing = true;
        try {
          return await options.capture(authorizationId, cents, limitCents);
        } catch (error) {
          uncertain = true;
          throw error;
        } finally {
          capturing = false;
          if (closed) state.reviewing = false;
        }
      },
      release() {
        if (closed) return;
        closed = true;
        if (!capturing) state.reviewing = false;
      },
    };
  }
  const checkVoidedAuthorization = createVoidChecker(options, state);
  return { operation, beginReview, checkVoidedAuthorization };
}
