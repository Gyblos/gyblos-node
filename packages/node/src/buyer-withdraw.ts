// Recovers reusable devnet channels under the buyer runtime lock.
import { DEVNET, DEVNET_GENESIS } from '@gyblos/config';
import { batchPoolPathsIn } from '@gyblos/config/home';
import {
  WITHDRAW_STEPS,
  type UptoBuyerWithdrawStep,
} from '@gyblos/payments-upto';
import {
  recoverBatchPool,
  type BatchRecoveryOptions,
  type BatchRecoveryResult,
} from '@gyblos/payments-upto/batch-session';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  acquireProcessLock,
  ensurePrivatePaymentPaths,
} from '@gyblos/runtime/private-file';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';
import { roleSigner, type RoleConfig } from './roles';
import { readGenesis, type GenesisReader } from './seller-chain';

export { WITHDRAW_STEPS, type UptoBuyerWithdrawStep };
type BuyerWithdrawalResult = BatchRecoveryResult;

export function buyerChainWithdraw(
  genesis: GenesisReader = readGenesis,
  batchRpc?: BatchRecoveryOptions['rpc'],
): (
  role: RoleConfig,
  report: (result: BuyerWithdrawalResult) => Promise<void>,
) => Promise<BuyerWithdrawalResult[]> {
  return async (inputRole, report) => {
    const role = { ...inputRole };
    if (role.role !== P2P_ROLES.BUYER)
      throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
    const paths = batchPoolPathsIn(process.env);
    const lock = await ensurePrivatePaymentPaths({
      directory: paths.directory,
      lock: paths.runtimeLock,
    })
      .then(() => acquireProcessLock(paths.runtimeLock))
      .catch(() => {
        throw new NodeError(NODE_ERROR_CODES.BUYER_RUNTIME_UNAVAILABLE);
      });
    try {
      const { rpcUrl, mint } = role;
      // Devnet only: this signs and spends fees from the buyer's wallet.
      const served = await genesis(rpcUrl).catch(() => undefined);
      if (served !== DEVNET_GENESIS)
        throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH);
      const payer = await roleSigner(P2P_ROLES.BUYER, P2P_ROLES.BUYER).catch(
        () => {
          throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
        },
      );
      const batch = await recoverBatchPool({
        paths,
        payer,
        rpcUrl,
        policy: { network: DEVNET, mint },
        ...(batchRpc ? { rpc: batchRpc } : {}),
      });
      for (const result of batch) await report(result);
      return batch;
    } finally {
      await lock.release();
    }
  };
}
