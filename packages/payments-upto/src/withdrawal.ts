// Wraps the generic withdrawal adapter with Gyblos's code-level network lock.
import {
  createUptoWithdrawal as createWithdrawal,
  type UptoWithdrawRpc as GenericWithdrawRpc,
  type UptoWithdrawOptions,
} from 'x402-upto-metered';

import { assertPaymentNetworkEnabled } from './mainnet';
import { verifyPaymentNetwork, type PaymentGenesisRpc } from './seller-network';

export type UptoWithdrawRpc = GenericWithdrawRpc & PaymentGenesisRpc;

export function createUptoWithdrawal(
  rpc: UptoWithdrawRpc,
  options: UptoWithdrawOptions,
) {
  const network = options.network;
  assertPaymentNetworkEnabled(network);
  const fixedRpc: UptoWithdrawRpc = {
    getGenesisHash: rpc.getGenesisHash.bind(rpc),
    getAccountInfo: rpc.getAccountInfo.bind(rpc),
    getSlot: rpc.getSlot.bind(rpc),
    getBlockTime: rpc.getBlockTime.bind(rpc),
    getLatestBlockhash: rpc.getLatestBlockhash.bind(rpc),
    sendTransaction: rpc.sendTransaction.bind(rpc),
    getSignatureStatuses: rpc.getSignatureStatuses.bind(rpc),
  };
  const withdrawal = createWithdrawal(fixedRpc, {
    payer: options.payer,
    network,
    tokenProgram: options.tokenProgram,
    ...(options.sleep ? { sleep: options.sleep.bind(options) } : {}),
  });
  return {
    async withdraw(query: Parameters<typeof withdrawal.withdraw>[0]) {
      await verifyPaymentNetwork(fixedRpc, network);
      return withdrawal.withdraw(query);
    },
  };
}
