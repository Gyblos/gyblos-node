// Exposes a buyer's own loopback endpoint and startup policy without exposing its bearer token.
import { LOCALHOST, ROUTES } from '@gyblos/config';

import { PAID_BUYER } from './constants';

export function ownedChat(
  model: string,
  maxTokens: number,
  maxAtomic: string,
  endpoint: string,
  token?: string,
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOCALHOST ||
    url.pathname !== ROUTES.inference ||
    !url.port ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Invalid local endpoint');
  const request: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    if (token)
      headers.set('authorization', `${PAID_BUYER.authScheme} ${token}`);
    return fetch(endpoint, { ...init, headers, redirect: 'error' });
  };
  return { model, maxTokens, maxAtomic, request };
}
