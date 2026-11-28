import {
  controlAddress,
  controlAtomic,
  controlObject,
} from '../control-validation';
import { SESSION_CODES } from '../sessions/constants';
import { BUYER_KEY_CODES } from './constants';

const blockers = [
  BUYER_KEY_CODES.REVIEW,
  SESSION_CODES.OPENING_RETURNED,
  SESSION_CODES.EXPIRED,
  SESSION_CODES.CLOSED,
  SESSION_CODES.STATUS_UNKNOWN,
  SESSION_CODES.REPLACEMENT_REQUIRED,
  SESSION_CODES.BINDING,
] as const;
export type ChannelBlocker = (typeof blockers)[number];
export function isChannelBlocker(value: unknown): value is ChannelBlocker {
  return blockers.some((code) => code === value);
}
export interface PaidChannelEligibility {
  channelId?: string;
  renewalDepositAtomic?: string;
  blocker: ChannelBlocker | null;
  channelRemainingAtomic: string | null;
}

export function parsePaidChannelEligibility(
  value: unknown,
): PaidChannelEligibility {
  const hasChannel =
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'channelId');
  const hasRenewal =
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'renewalDepositAtomic');
  const row = controlObject(value, [
    ...(hasRenewal ? ['renewalDepositAtomic'] : []),
    'blocker',
    'channelRemainingAtomic',
    ...(hasChannel ? ['channelId'] : []),
  ]);
  if (
    (hasRenewal &&
      (!hasChannel ||
        row.blocker !== null ||
        row.renewalDepositAtomic === '0')) ||
    (row.blocker !== null && !isChannelBlocker(row.blocker)) ||
    (row.blocker !== null &&
      row.blocker !== SESSION_CODES.REPLACEMENT_REQUIRED &&
      (hasChannel || row.channelRemainingAtomic !== null)) ||
    hasChannel !== (row.channelRemainingAtomic !== null)
  )
    throw new Error('Invalid buyer channel status');
  return {
    blocker: row.blocker,
    ...(hasRenewal && {
      renewalDepositAtomic: controlAtomic(row.renewalDepositAtomic),
    }),
    channelRemainingAtomic:
      row.channelRemainingAtomic === null
        ? null
        : controlAtomic(row.channelRemainingAtomic),
    ...(hasChannel && { channelId: controlAddress(row.channelId) }),
  };
}
