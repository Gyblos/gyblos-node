// Public payment funding facts. Unknown observations are distinct from confirmed zero.
import { DEVNET } from '@gyblos/config/network';
import {
  controlAddress,
  controlAtomic,
  controlObject,
} from '@gyblos/protocol/control-validation';

export const FUNDING = {
  balance: 'desktop:buyer-funding',
  copy: 'desktop:copy-funding-address',
  faucet: 'desktop:open-devnet-faucet',
  circle: 'https://faucet.circle.com/',
} as const;
export interface BuyerFunding {
  network: typeof DEVNET;
  payer: string;
  balanceAtomic: string | null;
  faucetAvailable: boolean;
  channelRemainingAtomic: string | null;
  switchingAtomic?: string;
  replacementAtomic?: string;
}
export function sellerResponseLimit(
  funding: BuyerFunding | null,
  deposit: string,
) {
  return (
    funding?.channelRemainingAtomic ??
    funding?.switchingAtomic ??
    funding?.replacementAtomic ??
    deposit
  );
}
export function autoFundingAvailable(
  policy: { payer: string; depositAtomic?: string; maxAtomic: string },
  observations: readonly (BuyerFunding | null)[],
) {
  const deposit = policy.depositAtomic;
  if (!deposit || !observations.length) return null;
  const capacity = observations.map((item) => {
    if (!item || item.payer !== policy.payer) return null;
    const escrow = item.channelRemainingAtomic ?? item.switchingAtomic;
    if (escrow != null && BigInt(escrow) >= BigInt(policy.maxAtomic))
      return true;
    if (escrow != null) return false;
    if (
      item.replacementAtomic !== undefined &&
      BigInt(item.replacementAtomic) < BigInt(policy.maxAtomic)
    )
      return false;
    if (item.balanceAtomic === null) return null;
    return (
      BigInt(item.balanceAtomic) >= BigInt(item.replacementAtomic ?? deposit)
    );
  });
  if (capacity.includes(true)) return true;
  return capacity.includes(null) ? null : false;
}
export function depositShortfall(balanceAtomic: string, depositAtomic: string) {
  const difference =
    BigInt(controlAtomic(depositAtomic)) - BigInt(controlAtomic(balanceAtomic));
  return difference > 0n ? String(difference) : '0';
}
export function parseBuyerFunding(value: unknown): BuyerFunding | null {
  try {
    const row = controlObject(value, [
      'network',
      'payer',
      'balanceAtomic',
      'faucetAvailable',
      'channelRemainingAtomic',
      ...(value &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'switchingAtomic')
        ? ['switchingAtomic']
        : []),
      ...(value &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'replacementAtomic')
        ? ['replacementAtomic']
        : []),
    ]);
    if (
      row.network !== DEVNET ||
      row.faucetAvailable !== (row.balanceAtomic !== null)
    )
      return null;
    return {
      network: DEVNET,
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
