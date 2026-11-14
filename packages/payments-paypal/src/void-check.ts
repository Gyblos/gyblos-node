// Checks a sandbox void without inferring whether earlier captures occurred.
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
async function verify(
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
  if (
    !Array.isArray(payments.authorizations) ||
    payments.authorizations.length !== 1
  )
    return fail();
  const nested = object(payments.authorizations[0]);
  if (
    nested.id !== authorizationId ||
    (nested.status !== undefined &&
      nested.status !== PAYPAL_AUTHORIZATION_STATUS.CREATED &&
      nested.status !== PAYPAL_AUTHORIZATION_STATUS.VOIDED) ||
    (nested.amount !== undefined && !matchesAmount(nested.amount, limitCents))
  )
    return fail();
  const current = object(
    (await get(`/v2/payments/authorizations/${authorizationId}`)).value,
  );
  if (
    current.id !== authorizationId ||
    current.status !== PAYPAL_AUTHORIZATION_STATUS.VOIDED ||
    !matchesAmount(current.amount, limitCents)
  )
    return fail();
}
export function createVoidChecker(
  options: {
    get: ReturnType<typeof transport>['get'];
    invalidate(): void;
  },
  state: { reviewing: boolean; inFlight: number },
) {
  return async (
    orderId: string,
    requestId: string,
    authorizationId: string,
    limitCents: number = PAYPAL_API.limitCents,
  ) => {
    if (state.reviewing || state.inFlight > 0)
      throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
    state.reviewing = true;
    try {
      options.invalidate();
      await verify(
        options.get,
        orderId,
        requestId,
        authorizationId,
        limitCents,
      );
    } finally {
      state.reviewing = false;
    }
  };
}
