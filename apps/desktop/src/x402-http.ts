// Bounded host-side responses from the owner-authenticated loopback buyer.
import { HTTP_STATUS, LOCALHOST, ROUTES } from '@gyblos/config';
import { withBatchOutputLimit } from '@gyblos/protocol/batch-channel';
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
  StaleSellerOffer,
  x402Policy,
} from './x402-model';

export type DesktopSellerChoice =
  BuyerSellerChoice | typeof OFFER_PRICING_KINDS.FREE | typeof BUYER_API.AUTO;
export function policyForRoute(
  policy: BuyerApiPolicy,
  route?: NonNullable<BuyerApiPolicy['autoRoutes']>[number],
  paid = false,
) {
  if (!route) return policy;
  const routed = { ...policy, model: route.id, maxTokens: route.maxTokens };
  return paid ? withBatchOutputLimit(routed) : routed;
}

export function policyForSeller(
  policy: BuyerApiPolicy,
  choice?: BuyerSellerChoice,
): BuyerApiPolicy {
  if (!choice) return policy;
  return withBatchOutputLimit({
    ...policy,
    model: choice.modelId,
    maxTokens: Math.min(choice.contextTokens, policy.maxTokens),
  });
}
export function chatHeaders(
  token: string,
  policyId: string,
  explicitFree?: boolean,
) {
  return {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
    'if-match': '"' + policyId + '"',
    ...(explicitFree && {
      [BUYER_API.EXPLICIT_FREE_HEADER]: OFFER_PRICING_KINDS.FREE,
    }),
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
async function buyerPolicyAction(
  connection: { url: URL; token: string; policy: BuyerApiPolicy },
  request: typeof fetch,
  path:
    | typeof BUYER_API.RECONCILE_POOL_PATH
    | typeof BUYER_API.PAID_PREPARATION_PATH,
  signal: AbortSignal,
) {
  const response = await request(new URL(path, connection.url), {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      authorization: 'Bearer ' + connection.token,
      'if-match': '"' + connection.policy.policyId + '"',
    },
  });
  await response.body?.cancel();
  return response.status;
}
export async function reconcileBuyerPool(
  connection: { url: URL; token: string; policy: BuyerApiPolicy },
  expected: BuyerApiPolicy,
  request: typeof fetch,
) {
  const { policy } = connection;
  if (
    policy.payer !== expected.payer ||
    policy.mint !== expected.mint ||
    policy.network !== expected.network
  )
    throw new Error('Buyer connection changed');
  const status = await buyerPolicyAction(
    connection,
    request,
    BUYER_API.RECONCILE_POOL_PATH,
    AbortSignal.timeout(DESKTOP_X402.REQUEST_MS),
  );
  if (status !== HTTP_STATUS.noContent) throw new Error('Unconfirmed payment');
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
  const status = await buyerPolicyAction(
    connection,
    request,
    BUYER_API.PAID_PREPARATION_PATH,
    AbortSignal.any([external, AbortSignal.timeout(DESKTOP_X402.REQUEST_MS)]),
  );
  external.throwIfAborted();
  if (status === HTTP_STATUS.noContent) {
    if (expiresAt !== undefined && expiresAt <= Date.now())
      throw new StaleSellerOffer(
        'The selected seller or terms changed. Refresh the listing before sending.',
      );
    return;
  }
  if (status === HTTP_STATUS.serviceUnavailable)
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

export function assertFreeBudget(
  current: Awaited<ReturnType<X402Budget['summary']>>,
  id: string,
) {
  if (
    !current.available ||
    current.blocked ||
    current.records.some((item) => item.id === id) ||
    current.records.length >= DESKTOP_X402.MAX_RECORDS
  )
    throw new Error('Chat history is unavailable or needs review.');
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
      throw new StaleSellerOffer('Seller listing expired');
    const notice = paidSellerLimitNotice(
      policy,
      current,
      typeof choice === 'object' ? choice.modelId : model,
    );
    if (notice) throw new PaidSellerLimitError(notice);
  }
}

export async function buyerConnection(
  response: Response,
  url: URL,
  token: string,
  managed: boolean,
) {
  const policy = x402Policy(await readJson(response));
  return {
    url,
    token,
    managed,
    policy,
    reconcilesPool:
      response.headers.get(BUYER_API.RECONCILE_POOL_HEADER) ===
      BUYER_API.RECONCILE_POOL_PATH,
    preparesPaidChat:
      response.headers.get(BUYER_API.PAID_PREPARATION_HEADER) ===
      BUYER_API.PAID_PREPARATION_PATH,
  };
}
