// PayPal Sandbox direct-merchant REST adapter; it cannot access live PayPal or an inference engine.
import { randomUUID } from 'node:crypto';

export const PAYPAL_SANDBOX = { currency: 'USD', price: '1.00' } as const;
const SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';
const APPROVAL_HOST = 'www.sandbox.paypal.com';
const PRICE = {
  currency_code: PAYPAL_SANDBOX.currency,
  value: PAYPAL_SANDBOX.price,
};
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const REQUEST_TIMEOUT_MS = 15_000;
const NO_CONTENT = 204;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid PayPal response');
  return Object.fromEntries(Object.entries(value));
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value))
    throw new Error('Invalid PayPal response');
  return value;
}

function correctAmount(value: unknown): boolean {
  const amount = object(value);
  return (
    amount.currency_code === PRICE.currency_code && amount.value === PRICE.value
  );
}

interface SandboxOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

function transport(options: SandboxOptions) {
  if (!options.clientId || !options.clientSecret)
    throw new Error('Sandbox credentials required');
  const fetchImpl = options.fetch ?? fetch;
  async function token(): Promise<string> {
    const credentials = Buffer.from(
      `${options.clientId}:${options.clientSecret}`,
    ).toString('base64');
    const response = await fetchImpl(`${SANDBOX_ORIGIN}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('PayPal Sandbox unavailable');
    const data = object(await response.json());
    if (typeof data.access_token !== 'string' || !data.access_token)
      throw new Error('Invalid PayPal response');
    return data.access_token;
  }
  async function post(path: string, body?: unknown): Promise<unknown> {
    const accessToken = await token();
    const response = await fetchImpl(`${SANDBOX_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'PayPal-Request-Id': randomUUID(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('PayPal Sandbox request unresolved');
    if (response.status === NO_CONTENT) return null;
    return response.json();
  }
  return post;
}

export function createPaypalSandbox(options: SandboxOptions) {
  const post = transport(options);
  return {
    async create() {
      const data = object(
        await post('/v2/checkout/orders', {
          intent: 'AUTHORIZE',
          purchase_units: [{ amount: PRICE }],
        }),
      );
      const orderId = id(data.id);
      if (!Array.isArray(data.links))
        throw new Error('Invalid PayPal response');
      const link = data.links
        .map(object)
        .find((item) => item.rel === 'payer-action' || item.rel === 'approve');
      if (!link || typeof link.href !== 'string' || !URL.canParse(link.href))
        throw new Error('Invalid PayPal response');
      const approval = new URL(link.href);
      if (
        approval.protocol !== 'https:' ||
        approval.hostname !== APPROVAL_HOST ||
        approval.username ||
        approval.password
      )
        throw new Error('Invalid PayPal response');
      return { orderId, approvalUrl: approval.href };
    },
    async authorize(orderId: string) {
      const data = object(
        await post(`/v2/checkout/orders/${id(orderId)}/authorize`),
      );
      if (
        data.id !== orderId ||
        data.status !== 'COMPLETED' ||
        !Array.isArray(data.purchase_units) ||
        data.purchase_units.length !== 1
      )
        throw new Error('Invalid PayPal response');
      const payments = object(object(data.purchase_units[0]).payments);
      if (
        !Array.isArray(payments.authorizations) ||
        payments.authorizations.length !== 1
      )
        throw new Error('Invalid PayPal response');
      const authorization = object(payments.authorizations[0]);
      if (
        authorization.status !== 'CREATED' ||
        !correctAmount(authorization.amount)
      )
        throw new Error('Invalid PayPal response');
      return { authorizationId: id(authorization.id) };
    },
    async capture(authorizationId: string) {
      const data = object(
        await post(
          `/v2/payments/authorizations/${id(authorizationId)}/capture`,
          {
            amount: PRICE,
            final_capture: true,
          },
        ),
      );
      if (data.status !== 'COMPLETED' || !correctAmount(data.amount))
        throw new Error('PayPal capture not confirmed');
      return { captureId: id(data.id) };
    },
    async void(authorizationId: string) {
      await post(`/v2/payments/authorizations/${id(authorizationId)}/void`);
    },
  };
}
