// Read-only desktop funding observations use the active buyer role, never the wallet selector.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { type HomeEnvironment } from '@gyblos/config/home';
import {
  batchPoolChannelPaths,
  batchPoolPathsIn,
} from '@gyblos/config/home-payments';
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import {
  finalizedRequestCharge,
  inspectBatchPool,
  inspectBatchSession,
  poolAllowsSellerDeposit,
} from '@gyblos/payments-upto/batch-session';
import type {
  BuyerApiPolicy,
  BuyerSellerChoice,
} from '@gyblos/protocol/buyer-api';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_STATES } from '@gyblos/protocol/payment-session';

import { loadRole } from './roles';

export { buyerUsdcBalance } from '@gyblos/payments-upto/buyer-funding';
export async function localFundingRole(
  environment: HomeEnvironment,
  policy: BuyerApiPolicy,
) {
  if (policy.network !== DEVNET || policy.mint !== DEVNET_USDC) return null;
  const role = await loadRole(P2P_ROLES.BUYER, environment);
  return role.role === P2P_ROLES.BUYER &&
    role.buyer === policy.payer &&
    role.mint === policy.mint
    ? role
    : null;
}
export async function switchingCredit(
  environment: HomeEnvironment,
  policy: BuyerApiPolicy,
  seller: BuyerSellerChoice,
) {
  const pool = batchPoolPathsIn(environment);
  if (policy.totalDepositAtomic && policy.depositAtomic) {
    const allowed = await poolAllowsSellerDeposit(
      pool,
      seller.nodeId,
      policy.totalDepositAtomic,
      policy.depositAtomic,
    );
    return allowed ? null : { poolLimited: true as const };
  }
  if ((await inspectBatchPool(pool, { includeLegacy: false })).length)
    return null;
  const root = await inspectBatchSession(pool.legacy);
  if (
    !root ||
    root.terms.sellerNodeId === seller.nodeId ||
    !policy.depositAtomic ||
    root.openingPending
  )
    return null;
  if (
    root.pending ||
    root.recoverable ||
    root.terms.buyer !== policy.payer ||
    root.terms.network !== policy.network ||
    root.terms.mint !== policy.mint ||
    root.snapshot.reservedAtomic !== '0'
  )
    return null;
  const funded =
    !!root.snapshot.channelId && root.snapshot.state === SESSION_STATES.OPEN;
  if (!funded && !root.archivedProof && !root.empty) return null;
  const spent = BigInt(root.snapshot.cumulativeAtomic);
  const authority =
    BigInt(policy.depositAtomic) - BigInt(root.priorSpentAtomic ?? '0') - spent;
  if (authority < 0n) return null;
  const replacementAtomic = String(authority);
  if (
    !funded ||
    authority < BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic) ||
    authority > BigInt(root.terms.depositAtomic) - spent
  )
    return { replacementAtomic };
  return { switchingAtomic: replacementAtomic };
}

export async function reviewDesktopCharge(
  environment: HomeEnvironment,
  ref: import('./desktop-opening').DesktopRequestBinding,
  policy: BuyerApiPolicy,
  signal?: AbortSignal,
) {
  const role = await localFundingRole(environment, policy);
  if (!role) return undefined;
  const pool = batchPoolPathsIn(environment);
  for (const paths of [
    pool.legacy,
    batchPoolChannelPaths(pool, ref.sellerNodeId),
  ]) {
    const result = await finalizedRequestCharge(
      paths,
      role.rpcUrl,
      ref,
      policy,
      signal,
    );
    if (result) return result;
  }
  return undefined;
}
