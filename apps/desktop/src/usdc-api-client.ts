// Owner-only key management through the connected buyer. Operator credentials never leave the host.
import { ROUTES } from '@gyblos/config';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
  type BuyerApiKeyCommand,
} from '@gyblos/protocol/buyer-api-keys';

import { DESKTOP_X402 } from './x402-model';

export async function requestBuyerApiKeys(
  connection: { url: URL; token: string; policy: BuyerApiPolicy },
  request: typeof fetch,
  signal: AbortSignal,
  command?: BuyerApiKeyCommand,
) {
  const response = await request(new URL(BUYER_API_KEYS.PATH, connection.url), {
    method: command ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(DESKTOP_X402.STATUS_MS),
    ]),
    headers: {
      authorization: 'Bearer ' + connection.token,
      'content-type': 'application/json',
      'if-match': '"' + connection.policy.policyId + '"',
    },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  if (!response.ok || !response.body)
    throw new Error('API key management is unavailable');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BUYER_API_KEYS.MAX_RESPONSE_BYTES)
        throw new Error('Invalid key status');
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
  const result = parseBuyerApiKeysReply(value);
  const expected = connection.policy;
  const actual = result.snapshot.scope;
  if (
    actual.network !== expected.network ||
    actual.mint !== expected.mint ||
    actual.payer !== expected.payer
  )
    throw new Error('Buyer wallet changed');
  return {
    ...result,
    url: new URL(ROUTES.agentBase, connection.url).href,
    model: expected.model,
  };
}
