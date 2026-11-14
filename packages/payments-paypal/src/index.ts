// PayPal Sandbox direct-merchant REST adapter; it cannot access live PayPal or an inference engine.
import { PAYPAL_SANDBOX_LIMIT_OPTIONS } from '@gyblos/config/constants';
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
  PAYPAL_RESOURCE_STATUS,
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

function limitAmount(cents: number = PAYPAL_API.limitCents) {
  if (!PAYPAL_SANDBOX_LIMIT_OPTIONS.some((limit) => limit === cents))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  return (cents / PAYPAL_API.centsPerDollar).toFixed(2);
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

function confirmedVoid(
  value: unknown,
  authorizationId: string,
  limitCents?: number,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = Object.fromEntries(Object.entries(value));
  if (
    data.id !== authorizationId ||
    data.status !== PAYPAL_AUTHORIZATION_STATUS.VOIDED
  )
    return false;
  if (data.amount === undefined) return true;
  if (
    !data.amount ||
    typeof data.amount !== 'object' ||
    Array.isArray(data.amount)
  )
    return false;
  return correctAmount(data.amount, limitAmount(limitCents));
}

function parseCreatedOrder(
  value: unknown,
  requestId: string,
  limitCents?: number,
) {
  const data = object(value);
  const orderId = id(data.id);
  if (
    data.status !== PAYPAL_ORDER_STATUS.CREATED &&
    data.status !== PAYPAL_ORDER_STATUS.PAYER_ACTION_REQUIRED
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  validateOrderTerms(data, id(requestId), false, limitCents);
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
  limitCents?: number,
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
    (unit.amount !== undefined &&
      !correctAmount(unit.amount, limitAmount(limitCents)))
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
    !correctAmount(authorization.amount, limitAmount(limitCents))
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
  limitCents?: number,
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
  validateOrderTerms(data, expectedRequest, approved, limitCents);
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
  limitCents?: number,
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
    ((required || unit.amount !== undefined) &&
      !correctAmount(unit.amount, limitAmount(limitCents)))
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  if (unit.payments !== undefined) {
    const payments = object(unit.payments);
    rejectPriorPayments(payments, false);
  }
}

function validateCapture(
  authorizationId: string,
  cents?: number,
  limitCents: number = PAYPAL_API.limitCents,
) {
  id(authorizationId);
  limitAmount(limitCents);
  if (
    cents !== undefined &&
    (!Number.isSafeInteger(cents) || cents < 1 || cents > limitCents)
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
}
async function captureAuthorized(
  post: ReturnType<typeof transport>['post'],
  authorizationId: string,
  cents?: number,
  limitCents: number = PAYPAL_API.limitCents,
) {
  validateCapture(authorizationId, cents, limitCents);
  const expected =
    cents === undefined
      ? limitAmount(limitCents)
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
  if (
    data.status !== PAYPAL_RESOURCE_STATUS.COMPLETED ||
    !correctAmount(data.amount, expected)
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
  return { captureId: id(data.id) };
}

async function createOrder(
  post: ReturnType<typeof transport>['post'],
  callback: string,
  requestId: string,
  returnState?: string,
  limitCents?: number,
) {
  const value = limitAmount(limitCents);
  if (returnState !== undefined && !isPaypalReturnState(returnState))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  const query = returnState === undefined ? '' : `?state=${returnState}`;
  return parseCreatedOrder(
    await post(
      '/v2/checkout/orders',
      {
        intent: PAYPAL_ORDER_INTENT.AUTHORIZE,
        purchase_units: [
          { amount: { ...PAYPAL_API.price, value }, custom_id: id(requestId) },
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
    limitCents,
  );
}

async function voidAuthorized(
  post: ReturnType<typeof transport>['post'],
  authorizationId: string,
  limitCents?: number,
) {
  limitAmount(limitCents);
  const result = await post(
    `/v2/payments/authorizations/${id(authorizationId)}/void`,
    undefined,
    [HTTP_STATUS.ok, PAYPAL_API.noContent],
    `void-${id(authorizationId)}`,
    true,
  );
  if (
    result !== undefined &&
    !confirmedVoid(result, authorizationId, limitCents)
  )
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
  if (
    data.status !== PAYPAL_RESOURCE_STATUS.COMPLETED ||
    !correctAmount(data.amount)
  )
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
    create: (requestId: string, returnState?: string, limitCents?: number) =>
      createOrder(post, callback, requestId, returnState, limitCents),
    capture: (authorizationId: string, cents?: number, limitCents?: number) =>
      captureAuthorized(post, authorizationId, cents, limitCents),
    void: (authorizationId: string, limitCents?: number) =>
      voidAuthorized(post, authorizationId, limitCents),
    refund: (captureId: string) => refundCaptured(post, captureId),
  };
}
type ApprovedToken = {
  orderId: string;
  requestId: string;
  accessToken: string;
  limitCents: number;
};

async function authorizeReserved(
  post: ReturnType<typeof transport>['post'],
  orderId: string,
  requestId: string,
  limitCents: number,
  accessToken: string,
) {
  return parseAuthorization(
    await post(
      `/v2/checkout/orders/${orderId}/authorize`,
      undefined,
      undefined,
      `authorize-${orderId}`,
      false,
      accessToken,
    ),
    orderId,
    requestId,
    limitCents,
  );
}
class PaypalApproval {
  private revision = 0;
  private authorizing = false;
  private approvedToken: ApprovedToken | undefined;
  constructor(
    private readonly post: ReturnType<typeof transport>['post'],
    private readonly get: ReturnType<typeof transport>['get'],
  ) {}
  invalidate = () => {
    this.revision += 1;
    this.approvedToken = undefined;
  };
  async isApproved(
    orderId: string,
    requestId: string,
    limitCents: number = PAYPAL_API.limitCents,
  ) {
    limitAmount(limitCents);
    if (this.authorizing) throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
    this.invalidate();
    const current = this.revision;
    const result = await isOrderApproved(
      this.get,
      orderId,
      requestId,
      limitCents,
    );
    if (this.revision !== current)
      throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
    if (result.approved)
      this.approvedToken = {
        orderId,
        requestId,
        accessToken: result.accessToken,
        limitCents,
      };
    return result.approved;
  }
  async authorize(
    orderId: string,
    requestId: string,
    limitCents: number = PAYPAL_API.limitCents,
  ) {
    limitAmount(limitCents);
    if (this.authorizing) throw new PaypalError(PAYPAL_ERROR_CODES.BUSY);
    const expectedRequest = id(requestId);
    const expectedOrder = id(orderId);
    const reserved = this.approvedToken;
    this.invalidate();
    if (
      !reserved ||
      reserved.orderId !== expectedOrder ||
      reserved.requestId !== expectedRequest ||
      reserved.limitCents !== limitCents
    )
      throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
    this.authorizing = true;
    try {
      return await authorizeReserved(
        this.post,
        orderId,
        expectedRequest,
        limitCents,
        reserved.accessToken,
      );
    } finally {
      this.authorizing = false;
    }
  }
}
export function createPaypalSandbox(options: SandboxOptions) {
  const callback = callbackOrigin(options.returnOrigin);
  const { post, prepare, get } = transport(options, object);
  const approval = new PaypalApproval(post, get);
  const { operation, beginReview, checkVoidedAuthorization } =
    createPaypalReviewAccess({
      get,
      validateCapture,
      capture: (authorizationId, cents, limitCents) =>
        captureAuthorized(post, authorizationId, cents, limitCents),
      invalidate: approval.invalidate,
    });
  return {
    prepare: () => operation(prepare),
    discardApproval: approval.invalidate,
    beginReview,
    checkVoidedAuthorization,
    isApproved: (orderId: string, requestId: string, limitCents?: number) =>
      operation(() => approval.isApproved(orderId, requestId, limitCents)),
    ...managedPaypalOperations(
      operation,
      approval.invalidate,
      sandboxActions(post, callback),
    ),
    authorize: (orderId: string, requestId: string, limitCents?: number) =>
      operation(() => approval.authorize(orderId, requestId, limitCents)),
  };
}
