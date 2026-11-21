// Bounded host-side responses from the owner-authenticated loopback buyer.
import { HTTP_STATUS, LOCALHOST, ROUTES } from '@gyblos/config';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

import { desktopBuyerFailure } from './buyer-error';
import { DESKTOP_X402, PaidSellerLimitError } from './x402-model';

export async function readJson(response: Response, allowError = false) {
  if ((!response.ok && !allowError) || !response.body)
    throw new Error('Buyer did not complete the request');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > DESKTOP_X402.MAX_RESPONSE)
        throw new Error('Buyer response is too large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value: unknown = JSON.parse(text);
  return value;
}
// The response must come from the same buyer process that will receive the later chat.
export async function waitForPaidBuyer(
  connection: {
    url: URL;
    token: string;
    policy: BuyerApiPolicy;
    preparesPaidChat: boolean;
  },
  request: typeof fetch,
  external: AbortSignal,
  expiresAt?: number,
) {
  if (!connection.preparesPaidChat || connection.policy.maxAtomic === '0')
    return;
  const response = await request(
    new URL(BUYER_API.PAID_PREPARATION_PATH, connection.url),
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([
        external,
        AbortSignal.timeout(DESKTOP_X402.REQUEST_MS),
      ]),
      headers: {
        authorization: 'Bearer ' + connection.token,
        'if-match': '"' + connection.policy.policyId + '"',
      },
    },
  );
  await response.body?.cancel();
  external.throwIfAborted();
  if (response.status === HTTP_STATUS.noContent) {
    if (expiresAt !== undefined && expiresAt <= Date.now())
      throw new PaidSellerLimitError(
        'The selected seller or terms changed. Refresh the listing before sending.',
      );
    return;
  }
  if (response.status === HTTP_STATUS.serviceUnavailable)
    throw desktopBuyerFailure(
      {
        code: BUYER_API.TOKENIZER_UNAVAILABLE,
        [BUYER_API.NEVER_SENT_FIELD]: true,
      },
      connection.policy,
    );
  throw new PaidSellerLimitError(
    'The local buyer could not prepare this chat. Reconnect the buyer and select the seller again.',
  );
}

export function buyerEndpoint(input: unknown) {
  if (typeof input !== 'string') throw new Error('Enter a local buyer URL');
  const url = new URL(input);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOCALHOST ||
    !url.port ||
    url.pathname !== ROUTES.inference ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use the local buyer URL at http://127.0.0.1:port/v1/chat/completions',
    );
  return url;
}
