// Bounded host-side responses from the owner-authenticated loopback buyer.
import { HTTP_STATUS, LOCALHOST, ROUTES } from '@gyblos/config';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import {
  BUYER_API,
  type BuyerApiPolicy,
  type BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { desktopBuyerFailure } from './buyer-error';
import type { X402Budget } from './x402-budget';
import {
  DESKTOP_X402,
  PaidSellerLimitError,
  paidSellerLimitNotice,
} from './x402-model';

export type DesktopSellerChoice =
  BuyerSellerChoice | typeof OFFER_PRICING_KINDS.FREE | typeof BUYER_API.AUTO;
export function policyForRoute(
  policy: BuyerApiPolicy,
  route?: NonNullable<BuyerApiPolicy['autoRoutes']>[number],
  paid = false,
) {
  if (!route) return policy;
  return {
    ...policy,
    model: route.id,
    maxTokens: paid
      ? Math.min(route.maxTokens, BATCH_CHANNEL.maxOutputTokens)
      : route.maxTokens,
  };
}

export function policyForSeller(
  policy: BuyerApiPolicy,
  choice?: BuyerSellerChoice,
): BuyerApiPolicy {
  if (!choice) return policy;
  return {
    ...policy,
    model: choice.modelId,
    maxTokens: Math.min(
      choice.contextTokens,
      policy.maxTokens,
      BATCH_CHANNEL.maxOutputTokens,
    ),
  };
}
export function sellerFields(choice?: DesktopSellerChoice) {
  if (choice === OFFER_PRICING_KINDS.FREE)
    return { [BUYER_API.FREE_ONLY_FIELD]: true };
  if (choice === BUYER_API.AUTO) return { [BUYER_API.AUTO_FIELD]: true };
  return choice && { [BUYER_API.SELLER_CHOICE_FIELD]: choice };
}

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

export function validateChoice(
  choice: BuyerSellerChoice | typeof BUYER_API.AUTO | undefined,
  policy: BuyerApiPolicy,
  current: Awaited<ReturnType<X402Budget['summary']>>,
  model = policy.model,
) {
  if (choice) {
    if (choice === BUYER_API.AUTO && !policy.paidAuto)
      throw new PaidSellerLimitError('Enable paid Auto in Payments first.');
    if (typeof choice === 'object' && choice.expiresAt <= Date.now())
      throw new Error('Seller listing expired');
    const notice = paidSellerLimitNotice(
      policy,
      current,
      typeof choice === 'object' ? choice.modelId : model,
    );
    if (notice) throw new PaidSellerLimitError(notice);
  }
}
