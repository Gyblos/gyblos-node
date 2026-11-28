// Public payment funding facts. Unknown observations are distinct from confirmed zero.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { DEVNET } from '@gyblos/config/network';
import { channelBlockerMessage } from '@gyblos/node/buyer-channel-message';
import {
  isChannelBlocker,
  type ChannelBlocker,
} from '@gyblos/protocol/buyer-api';
import {
  controlAddress,
  controlAtomic,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

export const FUNDING = {
  balance: 'desktop:buyer-funding',
  channelLimit: 'channel-limit',
  copy: 'desktop:copy-funding-address',
  faucet: 'desktop:open-devnet-faucet',
  circle: 'https://faucet.circle.com/',
} as const;
export interface BuyerFunding {
  network: typeof DEVNET;
  payer: string;
  balanceAtomic: string | null;
  lastBalanceAtomic?: string;
  lastBalanceAt?: number;
  faucetAvailable: boolean;
  channelId?: string;
  channelRemainingAtomic: string | null;
  renewalDepositAtomic?: string;
  switchingAtomic?: string;
  replacementAtomic?: string;
  poolLimited?: true;
  channelBlocker?: ChannelBlocker;
}
export function sellerChannelStatus(funding: BuyerFunding | null) {
  const blocker = funding?.channelBlocker;
  if (blocker === SESSION_CODES.CLOSED)
    return {
      label: 'Settled',
      description:
        'Final settlement is confirmed. Review the previous deposit before authorizing a replacement.',
    };
  if (blocker === SESSION_CODES.EXPIRED)
    return {
      label: 'Expired',
      description:
        'This channel has expired. Review the previous deposit before authorizing a replacement.',
    };
  if (!funding || blocker === SESSION_CODES.STATUS_UNKNOWN)
    return {
      label: 'Needs review',
      description: 'Spending is paused until the buyer can verify the channel.',
    };
  if (blocker)
    return {
      label: 'Needs review',
      description: channelBlockerMessage(blocker),
    };
  if (
    funding.channelId &&
    funding.channelRemainingAtomic !== null &&
    (BigInt(funding.channelRemainingAtomic) > 0n || fundedRenewal(funding))
  )
    return {
      label: 'Ready',
      description: 'The buyer will check this channel again when you send.',
    };
  return {
    label: 'No verified channel',
    description: 'Review the seller and deposit terms before sending.',
  };
}
function fundedRenewal(funding: BuyerFunding) {
  if (
    !funding.renewalDepositAtomic ||
    funding.channelRemainingAtomic === null ||
    funding.balanceAtomic === null
  )
    return undefined;
  return BigInt(funding.balanceAtomic) +
    BigInt(funding.channelRemainingAtomic) >=
    BigInt(funding.renewalDepositAtomic)
    ? funding.renewalDepositAtomic
    : undefined;
}
export function sellerResponseLimit(
  funding: BuyerFunding | null,
  deposit: string,
) {
  return (
    (funding && fundedRenewal(funding)) ??
    funding?.channelRemainingAtomic ??
    funding?.switchingAtomic ??
    funding?.replacementAtomic ??
    deposit
  );
}
type FundingPolicy = {
  payer: string;
  depositAtomic?: string;
  maxAtomic: string;
};
export function autoFundingAvailable(
  policy: FundingPolicy,
  observations: readonly (BuyerFunding | null)[],
  paidAutoSelection = false,
) {
  const deposit = policy.depositAtomic;
  if (!deposit || !observations.length) return null;
  const capacity = observations.map((item) => {
    if (!item || item.payer !== policy.payer) return null;
    if (item.channelBlocker) {
      const fundedSwitch =
        paidAutoSelection &&
        item.channelBlocker === SESSION_CODES.REPLACEMENT_REQUIRED &&
        !item.poolLimited &&
        !item.channelId &&
        item.channelRemainingAtomic === null &&
        item.replacementAtomic === undefined &&
        item.switchingAtomic !== undefined &&
        BigInt(item.switchingAtomic) >= BigInt(policy.maxAtomic);
      return fundedSwitch || item.channelBlocker;
    }
    if (item.poolLimited) return FUNDING.channelLimit;
    const escrow = item.channelRemainingAtomic ?? item.switchingAtomic;
    if (escrow != null && BigInt(escrow) >= BigInt(policy.maxAtomic))
      return true;
    if (
      item.renewalDepositAtomic &&
      BigInt(item.renewalDepositAtomic) >= BigInt(policy.maxAtomic)
    )
      return item.balanceAtomic === null ? null : Boolean(fundedRenewal(item));
    if (escrow != null) return FUNDING.channelLimit;
    if (
      item.replacementAtomic !== undefined &&
      (BigInt(item.replacementAtomic) < BigInt(policy.maxAtomic) ||
        BigInt(item.replacementAtomic) <
          BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic))
    )
      return FUNDING.channelLimit;
    if (item.balanceAtomic === null) return null;
    return (
      BigInt(item.balanceAtomic) >= BigInt(item.replacementAtomic ?? deposit)
    );
  });
  if (capacity.includes(true)) return true;
  const blocker = capacity.find(isChannelBlocker);
  if (blocker) return blocker;
  if (capacity.includes(null)) return null;
  return capacity.includes(false) ? false : FUNDING.channelLimit;
}
export type ReplacementTerms = Pick<
  BuyerFunding,
  'switchingAtomic' | 'replacementAtomic'
>;
export function pinnedFundingNotice(
  funding: BuyerFunding | null,
  policy: FundingPolicy | null | undefined,
  consent?: ReplacementTerms,
) {
  const blocker = funding
    ? funding.channelBlocker
    : SESSION_CODES.STATUS_UNKNOWN;
  const reviewedReplacement =
    blocker === SESSION_CODES.REPLACEMENT_REQUIRED &&
    funding &&
    consent &&
    funding.channelRemainingAtomic === null &&
    (consent.switchingAtomic !== undefined ||
      consent.replacementAtomic !== undefined) &&
    funding.switchingAtomic === consent.switchingAtomic &&
    funding.replacementAtomic === consent.replacementAtomic;
  if (blocker && !reviewedReplacement) return channelBlockerMessage(blocker);
  const available = policy
    ? autoFundingAvailable(policy, [
        reviewedReplacement
          ? { ...funding, channelBlocker: undefined }
          : funding,
      ])
    : null;
  return available === true ? undefined : autoFundingNotice(available);
}
export function autoFundingNotice(
  available: Exclude<ReturnType<typeof autoFundingAvailable>, true>,
  partial = false,
) {
  if (isChannelBlocker(available))
    return (
      channelBlockerMessage(available) +
      (partial ? ' The catalog is partial. Try again.' : '')
    );
  if (partial)
    return 'The catalog is partial. No seller in these results has verified funding for this response. Try again.';
  if (available === false) return 'Add devnet USDC to open a channel.';
  if (available === FUNDING.channelLimit)
    return 'Channel capacity cannot cover this response. Review Payments.';
  return 'Could not confirm channel funds. Check Payments and try again.';
}
export function depositShortfall(balanceAtomic: string, depositAtomic: string) {
  const difference =
    BigInt(controlAtomic(depositAtomic)) - BigInt(controlAtomic(balanceAtomic));
  return difference > 0n ? String(difference) : '0';
}
export function parseBuyerFunding(value: unknown): BuyerFunding | null {
  try {
    const optional = [
      'channelId',
      'channelBlocker',
      'poolLimited',
      'switchingAtomic',
      'replacementAtomic',
      'renewalDepositAtomic',
    ];
    const present = (key: string) =>
      value !== null && typeof value === 'object' && Object.hasOwn(value, key);
    const row = controlObject(value, [
      'network',
      'payer',
      'balanceAtomic',
      'faucetAvailable',
      'channelRemainingAtomic',
      ...optional.filter(present),
      ...(present('lastBalanceAtomic')
        ? ['lastBalanceAtomic', 'lastBalanceAt']
        : []),
    ]);
    if (
      (row.renewalDepositAtomic !== undefined &&
        (row.channelId === undefined ||
          row.channelRemainingAtomic === null ||
          row.channelBlocker !== undefined ||
          row.renewalDepositAtomic === '0' ||
          row.poolLimited ||
          row.switchingAtomic !== undefined ||
          row.replacementAtomic !== undefined)) ||
      (row.channelBlocker !== undefined &&
        !isChannelBlocker(row.channelBlocker)) ||
      (row.poolLimited !== undefined && row.poolLimited !== true) ||
      row.network !== DEVNET ||
      row.faucetAvailable !== (row.balanceAtomic !== null)
    )
      return null;
    return {
      network: DEVNET,
      ...(row.renewalDepositAtomic !== undefined && {
        renewalDepositAtomic: controlAtomic(row.renewalDepositAtomic),
      }),
      ...(row.channelId !== undefined && {
        channelId: controlAddress(row.channelId),
      }),
      ...(row.lastBalanceAtomic !== undefined && {
        lastBalanceAtomic: controlAtomic(row.lastBalanceAtomic),
        lastBalanceAt: controlInteger(row.lastBalanceAt, 1),
      }),
      ...(isChannelBlocker(row.channelBlocker) && {
        channelBlocker: row.channelBlocker,
      }),
      ...(row.poolLimited === true && { poolLimited: true }),
      ...(row.replacementAtomic !== undefined && {
        replacementAtomic: controlAtomic(row.replacementAtomic),
      }),
      ...(row.switchingAtomic !== undefined && {
        switchingAtomic: controlAtomic(row.switchingAtomic),
      }),
      faucetAvailable: row.faucetAvailable,
      payer: controlAddress(row.payer),
      balanceAtomic:
        row.balanceAtomic === null ? null : controlAtomic(row.balanceAtomic),
      channelRemainingAtomic:
        row.channelRemainingAtomic === null
          ? null
          : controlAtomic(row.channelRemainingAtomic),
    };
  } catch {
    return null;
  }
}
declare global {
  interface Window {
    desktopFunding?: {
      balance(offerId?: string): Promise<BuyerFunding | null>;
      copyAddress(expectedPayer: string): Promise<boolean>;
      openFaucet(expectedPayer: string): Promise<boolean>;
    };
  }
}
