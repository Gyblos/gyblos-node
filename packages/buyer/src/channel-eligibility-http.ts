import type { IncomingMessage, ServerResponse } from 'node:http';

import { HTTP_STATUS } from '@gyblos/config';
import { bounded } from '@gyblos/node/buyer-operation';
import { BUYER_PAYMENT_REVIEW } from '@gyblos/node/constants';
import {
  BUYER_API,
  parseBuyerSellerChoice,
  type BuyerApiPolicy,
  type BuyerSellerChoice,
  type PaidChannelEligibility,
} from '@gyblos/protocol/buyer-api';

import { readBody } from './chat-body';
import { replyJson } from './chat-errors';

export type InspectBuyerChannel = (
  choice: BuyerSellerChoice,
  signal: AbortSignal,
) => Promise<PaidChannelEligibility>;

export async function inspectChannelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  policy: BuyerApiPolicy | undefined,
  inspect: InspectBuyerChannel | undefined,
) {
  response.setHeader('cache-control', 'no-store');
  if (!inspect || !policy || request.headers.origin !== undefined) {
    response.writeHead(HTTP_STATUS.forbidden).end();
    return;
  }
  if (
    request.method !== 'POST' ||
    request.headers['content-type']?.split(';')[0] !== 'application/json'
  ) {
    response.writeHead(HTTP_STATUS.badRequest).end();
    return;
  }
  if (request.headers['if-match'] !== '"' + policy.policyId + '"') {
    response.writeHead(BUYER_API.POLICY_CHANGED_STATUS).end();
    return;
  }
  const signal = AbortSignal.timeout(BUYER_PAYMENT_REVIEW.deadlineMs);
  let choice: BuyerSellerChoice;
  try {
    choice = parseBuyerSellerChoice(
      await bounded(readBody(request, signal), signal),
      Date.now(),
    );
  } catch {
    response.writeHead(HTTP_STATUS.badRequest).end();
    return;
  }
  try {
    replyJson(response, await bounded(inspect(choice, signal), signal));
  } catch {
    response.writeHead(HTTP_STATUS.serviceUnavailable).end();
  }
}
