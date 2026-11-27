import { isChannelBlocker } from '@gyblos/buyer/channel-blocker';
import type { PaidChannelEligibility } from '@gyblos/buyer/channel-eligibility';
import { PAYMENT_REVIEW } from '@gyblos/buyer/constants';
import {
  BUYER_API,
  type BuyerApiPolicy,
  type BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';
import {
  controlAddress,
  controlAtomic,
  controlObject,
} from '@gyblos/protocol/control-validation';
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
          signal: AbortSignal.timeout(PAYMENT_REVIEW.deadlineMs),
          headers: {
            authorization: 'Bearer ' + connection.token,
            'content-type': 'application/json',
            'if-match': '"' + connection.policy.policyId + '"',
          },
          body: JSON.stringify(seller),
        },
      ),
    );
    const row = controlObject(value, [
      'blocker',
      'channelRemainingAtomic',
      ...(value &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'channelId')
        ? ['channelId']
        : []),
    ]);
    if (!current() || (row.blocker !== null && !isChannelBlocker(row.blocker)))
      throw new Error();
    return {
      blocker: row.blocker,
      channelRemainingAtomic:
        row.channelRemainingAtomic === null
          ? null
          : controlAtomic(row.channelRemainingAtomic),
      ...(row.channelId !== undefined && {
        channelId: controlAddress(row.channelId),
      }),
    };
  } catch {
    return {
      blocker: SESSION_CODES.STATUS_UNKNOWN,
      channelRemainingAtomic: null,
    };
  }
}
