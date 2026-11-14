// Buyer-controlled recovery of the existing batch journal; never executes inference or trusts a seller reply.
import type { createSolanaRpc } from '@solana/kit';
import type { UptoWithdrawResult } from 'x402-upto-metered';

import type { SessionSettlement } from '@gyblos/protocol/payment-session';

import type { BatchBuyerOptions, BatchPaths } from './batch-session-types';

export interface BatchRecoveryOptions {
  paths: BatchPaths;
  payer: BatchBuyerOptions['payer'];
  rpcUrl: string;
  rpc?: ReturnType<typeof createSolanaRpc>;
  now?: () => number;
}
export interface BatchRecoveryResult extends UptoWithdrawResult {
  channelId: string;
  settlement: SessionSettlement | null;
}

export async function recoverBatchBuyer(
  input: BatchRecoveryOptions,
): Promise<BatchRecoveryResult | undefined> {
  void input;
  return undefined;
}
