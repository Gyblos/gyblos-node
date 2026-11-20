import { DEVNET } from '@gyblos/config/network';

export function previewFunding(query: URLSearchParams, payer: string) {
  return {
    balance: async () =>
      query.get('network') && query.get('network') !== 'devnet'
        ? null
        : {
            network: DEVNET,
            payer,
            balanceAtomic: query.get('funding') === 'ready' ? '2000000' : '0',
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
