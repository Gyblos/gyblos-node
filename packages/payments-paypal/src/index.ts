// PayPal Sandbox direct-merchant REST adapter; it cannot access live PayPal or an inference engine.
import { HTTP_STATUS } from '@gyblos/config/limits';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  isPaypalId,
  isPaypalReturnState,
  PaypalError,
} from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_API,
  PAYPAL_AUTHORIZATION_STATUS,
  PAYPAL_ORDER_INTENT,
  PAYPAL_ORDER_STATUS,
} from './constants';
import { managedPaypalOperations } from './managed-operations';
import { createPaypalReviewAccess } from './review';
import { transport, type SandboxOptions } from './transport';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return Object.fromEntries(Object.entries(value));
}

function id(value: unknown): string {
  if (!isPaypalId(value))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return value;
}

function correctAmount(
  value: unknown,
  expected = PAYPAL_API.price.value,
): boolean {
  const amount = object(value);
  return (
    amount.currency_code === PAYPAL_API.price.currency_code &&
    amount.value === expected
  );
}

function confirmedVoid(value: unknown, authorizationId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = Object.fromEntries(Object.entries(value));
  if (data.id !== authorizationId || data.status !== 'VOIDED') return false;
  if (data.amount === undefined) return true;
  if (
    !data.amount ||
    typeof data.amount !== 'object' ||
    Array.isArray(data.amount)
  )
    return false;
  return correctAmount(data.amount);
}

function parseCreatedOrder(value: unknown, requestId: string) {
  const data = object(value);
  const orderId = id(data.id);
  if (
    data.status !== PAYPAL_ORDER_STATUS.CREATED &&
    data.status !== PAYPAL_ORDER_STATUS.PAYER_ACTION_REQUIRED
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  validateOrderTerms(data, id(requestId), false);
  if (!Array.isArray(data.links))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const link = data.links
    .map(object)
    .find((item) => item.rel === 'payer-action' || item.rel === 'approve');
  if (!link || typeof link.href !== 'string' || !URL.canParse(link.href))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const approval = new URL(link.href);
  const tokens = approval.searchParams.getAll('token');
  if (
    approval.protocol !== 'https:' ||
    approval.hostname !== PAYPAL_API.approvalHost ||
    approval.port ||
    approval.username ||
    approval.password ||
    tokens.length > 1 ||
    (tokens.length === 1 && tokens[0] !== orderId)
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return { orderId, approvalUrl: approval.href };
}

function parseAuthorization(
  value: unknown,
  orderId: string,
  requestId: string,
) {
  const data = object(value);
  if (
    data.id !== orderId ||
    data.status !== PAYPAL_ORDER_STATUS.COMPLETED ||
    !Array.isArray(data.purchase_units) ||
    data.purchase_units.length !== 1
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const unit = object(data.purchase_units[0]);
  if (
    (data.intent !== undefined &&
      data.intent !== PAYPAL_ORDER_INTENT.AUTHORIZE) ||
    (unit.custom_id !== undefined && unit.custom_id !== requestId) ||
    (unit.amount !== undefined && !correctAmount(unit.amount))
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const payments = object(unit.payments);
  rejectPriorPayments(payments, true);
  if (
    !Array.isArray(payments.authorizations) ||
    payments.authorizations.length !== 1
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const authorization = object(payments.authorizations[0]);
  if (
    authorization.status !== PAYPAL_AUTHORIZATION_STATUS.CREATED ||
    !correctAmount(authorization.amount)
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return { authorizationId: id(authorization.id) };
}

function callbackOrigin(returnOrigin: string): string {
  const callback = new URL(returnOrigin);
  if (
    callback.protocol !== 'http:' ||
    callback.hostname !== '127.0.0.1' ||
    !callback.port ||
    callback.pathname !== '/' ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_CONFIG);
  return callback.origin;
}

async function isOrderApproved(
  get: (path: string) => Promise<{ value: unknown; accessToken: string }>,
  orderId: string,
  requestId: string,
) {
  const expectedRequest = id(requestId);
  const result = await get(`/v2/checkout/orders/${id(orderId)}`);
  const data = object(result.value);
  if (data.id !== orderId)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const approved = data.status === PAYPAL_ORDER_STATUS.APPROVED;
  const pending =
    data.status === PAYPAL_ORDER_STATUS.CREATED ||
    data.status === PAYPAL_ORDER_STATUS.PAYER_ACTION_REQUIRED;
  if (!approved && !pending)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  validateOrderTerms(data, expectedRequest, approved);
  return { approved, accessToken: result.accessToken };
}

function rejectPriorPayments(
  payments: Record<string, unknown>,
  allowAuthorization: boolean,
) {
  for (const key of ['authorizations', 'captures', 'refunds']) {
    if (allowAuthorization && key === 'authorizations') continue;
    const entries = payments[key];
    if (
      entries !== undefined &&
      (!Array.isArray(entries) || entries.length > 0)
    )
      throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  }
}

function validateOrderTerms(
  data: Record<string, unknown>,
  requestId: string,
  required: boolean,
) {
  if (
    (required || data.intent !== undefined) &&
    data.intent !== PAYPAL_ORDER_INTENT.AUTHORIZE
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  if (!required && data.purchase_units === undefined) return;
  if (!Array.isArray(data.purchase_units) || data.purchase_units.length !== 1)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const unit = object(data.purchase_units[0]);
  if (
    ((required || unit.custom_id !== undefined) &&
      unit.custom_id !== requestId) ||
    ((required || unit.amount !== undefined) && !correctAmount(unit.amount))
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  if (unit.payments !== undefined) {
    const payments = object(unit.payments);
    rejectPriorPayments(payments, false);
  }
}

function validateCapture(authorizationId: string, cents?: number) {
  id(authorizationId);
  if (
    cents !== undefined &&
    (!Number.isSafeInteger(cents) || cents < 1 || cents > PAYPAL_API.limitCents)
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
}
async function captureAuthorized(
  post: ReturnType<typeof transport>['post'],
  authorizationId: string,
  cents?: number,
) {
  validateCapture(authorizationId, cents);
  const expected =
    cents === undefined
      ? PAYPAL_API.price.value
      : (cents / PAYPAL_API.centsPerDollar).toFixed(2);
  const data = object(
    await post(
      `/v2/payments/authorizations/${id(authorizationId)}/capture`,
      {
        amount: {
          currency_code: PAYPAL_API.price.currency_code,
          value: expected,
        },
        final_capture: true,
      },
      undefined,
      `capture-${id(authorizationId)}`,
    ),
  );
  if (data.status !== 'COMPLETED' || !correctAmount(data.amount, expected))
    throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
  return { captureId: id(data.id) };
}

async function createOrder(
  post: ReturnType<typeof transport>['post'],
  callback: string,
  requestId: string,
  returnState?: string,
) {
  if (returnState !== undefined && !isPaypalReturnState(returnState))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  const query = returnState === undefined ? '' : `?state=${returnState}`;
  return parseCreatedOrder(
    await post(
      '/v2/checkout/orders',
      {
        intent: PAYPAL_ORDER_INTENT.AUTHORIZE,
        purchase_units: [
          { amount: PAYPAL_API.price, custom_id: id(requestId) },
        ],
        application_context: {
          return_url: `${callback}/paypal/approved${query}`,
          cancel_url: `${callback}/paypal/cancelled${query}`,
        },
      },
      undefined,
      id(requestId),
    ),
    requestId,
  );
}

async function voidAuthorized(
  post: ReturnType<typeof transport>['post'],
  authorizationId: string,
) {
  const result = await post(
    `/v2/payments/authorizations/${id(authorizationId)}/void`,
    undefined,
    [HTTP_STATUS.ok, PAYPAL_API.noContent],
    `void-${id(authorizationId)}`,
    true,
  );
  if (result !== undefined && !confirmedVoid(result, authorizationId))
    throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
}

async function refundCaptured(
  post: ReturnType<typeof transport>['post'],
  captureId: string,
) {
  const data = object(
    await post(
      `/v2/payments/captures/${id(captureId)}/refund`,
      { amount: PAYPAL_API.price },
      undefined,
      `refund-${id(captureId)}`,
    ),
  );
  if (data.status !== 'COMPLETED' || !correctAmount(data.amount))
    throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
  id(data.id);
}

function sandboxActions(
  post: ReturnType<typeof transport>['post'],
  callback: string,
) {
  return {
    validateCapture,
    validateAuthorization: id,
    create: (requestId: string, returnState?: string) =>
      createOrder(post, callback, requestId, returnState),
    capture: (authorizationId: string, cents?: number) =>
      captureAuthorized(post, authorizationId, cents),
    void: (authorizationId: string) => voidAuthorized(post, authorizationId),
    refund: (captureId: string) => refundCaptured(post, captureId),
  };
}
export function createPaypalSandbox(options: SandboxOptions) {
  const callback = callbackOrigin(options.returnOrigin);
  const { post, prepare, get } = transport(options, object);
  let revision = 0;
  let authorizing = false;
  let approvedToken:
    { orderId: string; requestId: string; accessToken: string } | undefined;
  function invalidateApproval() {
    revision += 1;
    approvedToken = undefined;
  }
  const { operation, beginReview } = createPaypalReviewAccess({
    get,
    validateCapture,
    capture: (authorizationId, cents) =>
      captureAuthorized(post, authorizationId, cents),
    invalidate: invalidateApproval,
  });
  return {
    prepare: () => operation(prepare),
    discardApproval: invalidateApproval,
    beginReview,
    async isApproved(orderId: string, requestId: string) {
      return operation(async () => {
        if (authorizing) throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
        invalidateApproval();
        const current = revision;
        const result = await isOrderApproved(get, orderId, requestId);
        if (revision !== current)
          throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
        if (result.approved)
          approvedToken = {
            orderId,
            requestId,
            accessToken: result.accessToken,
          };
        return result.approved;
      });
    },
    ...managedPaypalOperations(
      operation,
      invalidateApproval,
      sandboxActions(post, callback),
    ),
    async authorize(orderId: string, requestId: string) {
      return operation(async () => {
        if (authorizing) throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
        const expectedRequest = id(requestId);
        const expectedOrder = id(orderId);
        const reserved = approvedToken;
        invalidateApproval();
        if (
          !reserved ||
          reserved.orderId !== expectedOrder ||
          reserved.requestId !== expectedRequest
        )
          throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
        authorizing = true;
        try {
          return parseAuthorization(
            await post(
              `/v2/checkout/orders/${expectedOrder}/authorize`,
              undefined,
              undefined,
              `authorize-${expectedOrder}`,
              false,
              reserved.accessToken,
            ),
            orderId,
            expectedRequest,
          );
        } finally {
          authorizing = false;
        }
      });
    },
  };
}
