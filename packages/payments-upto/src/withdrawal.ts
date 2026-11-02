// Wraps the generic withdrawal adapter with Gyblos's code-level network lock.
import {
  createUptoWithdrawal as createWithdrawal,
  type UptoWithdrawOptions,
  type UptoWithdrawRpc,
} from 'x402-upto-metered';

import { assertPaymentNetworkEnabled } from './mainnet';

export function createUptoWithdrawal(
  rpc: UptoWithdrawRpc,
  options: UptoWithdrawOptions,
) {
  const network = options.network;
  assertPaymentNetworkEnabled(network);
  return createWithdrawal(rpc, {
    payer: options.payer,
    network,
    tokenProgram: options.tokenProgram,
    ...(options.sleep ? { sleep: options.sleep.bind(options) } : {}),
  });
}
