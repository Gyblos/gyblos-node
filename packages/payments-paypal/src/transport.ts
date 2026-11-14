// Isolates sandbox HTTP requests and never logs credentials or provider bodies.
import { randomUUID } from 'node:crypto';

import { HTTP_STATUS } from '@gyblos/config/limits';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { PAYPAL_API } from './constants';

export interface SandboxOptions {
  clientId: string;
  clientSecret: string;
  returnOrigin: string;
  fetch?: typeof fetch;
}

async function requestToken(
  options: SandboxOptions,
  fetchImpl: typeof fetch,
  object: (value: unknown) => Record<string, unknown>,
) {
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

export function transport(
  options: SandboxOptions,
  object: (value: unknown) => Record<string, unknown>,
) {
  if (!options.clientId || !options.clientSecret)
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_CONFIG);
  const fetchImpl = options.fetch ?? fetch;
  let preparedToken: string | undefined;
  const token = () => requestToken(options, fetchImpl, object);
  async function post(
    path: string,
    body?: unknown,
    requiredStatuses: readonly number[] = [HTTP_STATUS.ok, HTTP_STATUS.created],
    requestId?: string,
    sanitizeResponse = false,
    reservedToken?: string,
  ): Promise<unknown> {
    const accessToken = reservedToken ?? preparedToken ?? (await token());
    if (reservedToken === undefined) preparedToken = undefined;
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
    if (!response.ok || !requiredStatuses.includes(response.status))
      throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
    if (response.status === PAYPAL_API.noContent) return undefined;
    if (!sanitizeResponse) return response.json();
    try {
      return await response.json();
    } catch {
      throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
    }
  }
  async function prepare() {
    preparedToken = await token();
  }
  async function get(
    path: string,
  ): Promise<{ value: unknown; accessToken: string }> {
    const accessToken = await token();
    const response = await fetchImpl(`${PAYPAL_API.origin}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(PAYPAL_API.timeoutMs),
    });
    if (response.status !== HTTP_STATUS.ok)
      throw new PaypalError(PAYPAL_ERROR_CODES.UNRESOLVED);
    try {
      return { value: await response.json(), accessToken };
    } catch {
      throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
    }
  }
  return { post, prepare, get };
}
