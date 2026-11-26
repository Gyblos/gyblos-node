import { DEVNET } from '@gyblos/config/network';

import { PREVIEW } from './constants';

declare global {
  interface Window {
    previewFunds?: { atomic: number; open: boolean };
  }
}

const READY_ATOMIC = 2_000_000;

export function previewFunding(payer: string) {
  return {
    balance: async () => {
      const query = new URLSearchParams(location.search);
      if (query.get('funding') === 'checking') {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PREVIEW.balanceCheckDelayMs);
        });
      }
      return query.get('network') && query.get('network') !== 'devnet'
        ? null
        : {
            network: DEVNET,
            payer,
            balanceAtomic: String(
              window.previewFunds?.atomic ??
                (query.get('funding') === 'ready' ||
                query.get('funding') === 'checking'
                  ? READY_ATOMIC
                  : 0),
            ),
            faucetAvailable: true,
            channelRemainingAtomic: null,
          };
    },
    copyAddress: async (current: string) => {
      if (current !== payer) return false;
      await navigator.clipboard.writeText(payer);
      return true;
    },
    openFaucet: async () => false,
  };
}
