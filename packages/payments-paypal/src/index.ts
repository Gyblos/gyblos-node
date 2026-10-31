// PayPal Sandbox direct-merchant REST adapter; it cannot access live PayPal or an inference engine.
import { randomUUID } from 'node:crypto';

import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';

import { PAYPAL_API } from './constants';

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

function correctAmount(value: unknown): boolean {
  const amount = object(value);
  return (
    amount.currency_code === PAYPAL_API.price.currency_code &&
    amount.value === PAYPAL_API.price.value
  );
}

interface SandboxOptions {
  clientId: string;
  clientSecret: string;
  returnOrigin: string;
  fetch?: typeof fetch;
}

function transport(options: SandboxOptions) {
  if (!options.clientId || !options.clientSecret)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_CONFIG);
  const fetchImpl = options.fetch ?? fetch;
  let preparedToken: string | undefined;
  async function token(): Promise<string> {
    const credentials = Buffer.from(
      `${options.clientId}:${options.clientSecret}`,
    ).toString('base64');
    const response = await fetchImpl(`${PAYPAL_API.origin}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      redirect: 'error',
      signal: AbortSignal.timeout(PAYPAL_API.timeoutMs),
    });
    if (!response.ok) throw new PaypalError(PAYPAL_ERROR_CODES.UNAVAILABLE);
    const data = object(await response.json());
    if (typeof data.access_token !== 'string' || !data.access_token)
      throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
    return data.access_token;
  }
  async function post(
    path: string,
    body?: unknown,
    requiredStatus?: number,
    requestId?: string,
  ): Promise<unknown> {
    const accessToken = preparedToken ?? (await token());
    preparedToken = undefined;
    const response = await fetchImpl(`${PAYPAL_API.origin}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'PayPal-Request-Id': requestId ?? randomUUID(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(PAYPAL_API.timeoutMs),
    });
    if (
      !response.ok ||
      (requiredStatus !== undefined && response.status !== requiredStatus)
    )
      throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
    if (response.status === PAYPAL_API.noContent) return null;
    return response.json();
  }
  async function prepare() {
    preparedToken = await token();
  }
  async function get(path: string): Promise<unknown> {
    const accessToken = await token();
    const response = await fetchImpl(`${PAYPAL_API.origin}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(PAYPAL_API.timeoutMs),
    });
    if (!response.ok) throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
    return response.json();
  }
  return { post, prepare, get };
}

function parseCreatedOrder(value: unknown) {
  const data = object(value);
  const orderId = id(data.id);
  if (!Array.isArray(data.links))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const link = data.links
    .map(object)
    .find((item) => item.rel === 'payer-action' || item.rel === 'approve');
  if (!link || typeof link.href !== 'string' || !URL.canParse(link.href))
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const approval = new URL(link.href);
  if (
    approval.protocol !== 'https:' ||
    approval.hostname !== PAYPAL_API.approvalHost ||
    approval.username ||
    approval.password
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return { orderId, approvalUrl: approval.href };
}

function parseAuthorization(value: unknown, orderId: string) {
  const data = object(value);
  if (
    data.id !== orderId ||
    data.status !== 'COMPLETED' ||
    !Array.isArray(data.purchase_units) ||
    data.purchase_units.length !== 1
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const payments = object(object(data.purchase_units[0]).payments);
  if (
    !Array.isArray(payments.authorizations) ||
    payments.authorizations.length !== 1
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  const authorization = object(payments.authorizations[0]);
  if (
    authorization.status !== 'CREATED' ||
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
  get: (path: string) => Promise<unknown>,
  orderId: string,
) {
  const data = object(await get(`/v2/checkout/orders/${id(orderId)}`));
  if (data.id !== orderId)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  return data.status === 'APPROVED';
}

export function createPaypalSandbox(options: SandboxOptions) {
  const callback = callbackOrigin(options.returnOrigin);
  const { post, prepare, get } = transport(options);
  return {
    prepare,
    async isApproved(orderId: string) {
      return isOrderApproved(get, orderId);
    },
    async create(requestId: string) {
      return parseCreatedOrder(
        await post(
          '/v2/checkout/orders',
          {
            intent: 'AUTHORIZE',
            purchase_units: [
              { amount: PAYPAL_API.price, custom_id: id(requestId) },
            ],
            application_context: {
              return_url: `${callback}/paypal/approved`,
              cancel_url: `${callback}/paypal/cancelled`,
            },
          },
          undefined,
          id(requestId),
        ),
      );
    },
    async authorize(orderId: string) {
      return parseAuthorization(
        await post(
          `/v2/checkout/orders/${id(orderId)}/authorize`,
          undefined,
          undefined,
          `authorize-${id(orderId)}`,
        ),
        orderId,
      );
    },
    async capture(authorizationId: string) {
      const data = object(
        await post(
          `/v2/payments/authorizations/${id(authorizationId)}/capture`,
          {
            amount: PAYPAL_API.price,
            final_capture: true,
          },
          undefined,
          `capture-${id(authorizationId)}`,
        ),
      );
      if (data.status !== 'COMPLETED' || !correctAmount(data.amount))
        throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
      return { captureId: id(data.id) };
    },
    async void(authorizationId: string) {
      await post(
        `/v2/payments/authorizations/${id(authorizationId)}/void`,
        undefined,
        PAYPAL_API.noContent,
        `void-${id(authorizationId)}`,
      );
    },
    async refund(captureId: string) {
      const data = object(
        await post(
          `/v2/payments/captures/${id(captureId)}/refund`,
          {
            amount: PAYPAL_API.price,
          },
          undefined,
          `refund-${id(captureId)}`,
        ),
      );
      if (data.status !== 'COMPLETED' || !correctAmount(data.amount))
        throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
      id(data.id);
    },
  };
}
