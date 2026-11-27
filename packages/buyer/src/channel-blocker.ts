import { BUYER_KEY_CODES } from '@gyblos/protocol/buyer-api-keys';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

const messages = {
  [BUYER_KEY_CODES.REVIEW]:
    'A spending reservation needs review. Both Desktop and delegated clients are paused. Check payment status in Desktop.',
  [SESSION_CODES.OPENING_RETURNED]:
    'The deposit was refunded. Review the previous payment before authorizing a replacement.',
  [SESSION_CODES.EXPIRED]:
    'This payment channel has expired. Review its status before authorizing a replacement.',
  [SESSION_CODES.CLOSED]:
    'This payment channel has closed. Review its settlement before authorizing a replacement.',
  [SESSION_CODES.STATUS_UNKNOWN]:
    'Channel status could not be verified. Check payment status before sending.',
  [SESSION_CODES.REPLACEMENT_REQUIRED]:
    'Confirm the replacement channel and its deposit before sending.',
  [SESSION_CODES.BINDING]:
    'The selected seller or terms changed. Refresh the listing before sending.',
};
export type ChannelBlocker = keyof typeof messages;
export function isChannelBlocker(value: unknown): value is ChannelBlocker {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}
export function channelBlockerMessage(code: ChannelBlocker) {
  return messages[code];
}
