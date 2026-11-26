import { DEVNET } from '@gyblos/config/network';

import { PREVIEW, PREVIEW_FUNDING } from './constants';

declare global {
  interface Window {
    previewFunds?: { atomic: number; open: boolean };
  }
}

export function previewFunding(payer: string) {
  return {
    balance: async () => {
      const query = new URLSearchParams(location.search);
      const mode = query.get('funding');
      if (mode === PREVIEW_FUNDING.CHECKING) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PREVIEW.balanceCheckDelayMs);
        });
      }
      const funded =
        mode === PREVIEW_FUNDING.READY || mode === PREVIEW_FUNDING.CHECKING;
      return query.get('network') && query.get('network') !== 'devnet'
        ? null
        : {
            network: DEVNET,
            payer,
            balanceAtomic: String(
              window.previewFunds?.atomic ??
                (funded ? PREVIEW_FUNDING.READY_ATOMIC : 0),
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
