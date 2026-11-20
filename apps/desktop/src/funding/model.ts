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
}
export function sellerResponseLimit(
  funding: BuyerFunding | null,
  deposit: string,
) {
  return funding?.channelRemainingAtomic ?? deposit;
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
    ]);
    if (
      row.network !== DEVNET ||
      row.faucetAvailable !== (row.balanceAtomic !== null)
    )
      return null;
    return {
      network: DEVNET,
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
