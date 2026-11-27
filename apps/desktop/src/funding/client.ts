import { BUYER_PAYMENT_REVIEW } from '@gyblos/node/constants';
import {
  BUYER_API,
  parsePaidChannelEligibility,
  type BuyerApiPolicy,
  type BuyerSellerChoice,
  type PaidChannelEligibility,
} from '@gyblos/protocol/buyer-api';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { readJson } from '../x402-http';

export async function inspectDesktopChannel(
  connection: { url: URL; token: string; policy: BuyerApiPolicy } | null,
  seller: BuyerSellerChoice,
  request: typeof fetch,
  current: () => boolean,
): Promise<PaidChannelEligibility> {
  try {
    if (!connection || !current()) throw new Error();
    const value = await readJson(
      await request(
        new URL(BUYER_API.CHANNEL_ELIGIBILITY_PATH, connection.url),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(BUYER_PAYMENT_REVIEW.deadlineMs),
          headers: {
            authorization: 'Bearer ' + connection.token,
            'content-type': 'application/json',
            'if-match': '"' + connection.policy.policyId + '"',
          },
          body: JSON.stringify(seller),
        },
      ),
    );
    if (!current()) throw new Error();
    return parsePaidChannelEligibility(value);
  } catch {
    return {
      blocker: SESSION_CODES.STATUS_UNKNOWN,
      channelRemainingAtomic: null,
    };
  }
}
