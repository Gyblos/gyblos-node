import { DEVNET } from '@gyblos/config/network';

declare global {
  interface Window {
    previewFunds?: { atomic: number; open: boolean };
  }
}

const READY_ATOMIC = 2_000_000;

export function previewFunding(query: URLSearchParams, payer: string) {
  return {
    balance: async () =>
      query.get('network') && query.get('network') !== 'devnet'
        ? null
        : {
            network: DEVNET,
            payer,
            balanceAtomic: String(
              window.previewFunds?.atomic ??
                (query.get('funding') === 'ready' ? READY_ATOMIC : 0),
            ),
            faucetAvailable: true,
            channelRemainingAtomic: null,
          },
    copyAddress: async (current: string) => {
      if (current !== payer) return false;
      await navigator.clipboard.writeText(payer);
      return true;
    },
    openFaucet: async () => false,
  };
}
