// Read-only desktop funding observations use the active buyer role, never the wallet selector.
import {
  batchPoolPathsIn,
  batchSessionPathsIn,
  type HomeEnvironment,
} from '@gyblos/config/home';
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import {
  inspectBatchPool,
  inspectBatchSession,
  type BatchStoredSession,
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
function available(
  stored: BatchStoredSession | undefined,
  policy: BuyerApiPolicy,
  seller: BuyerSellerChoice,
  now: number,
) {
  if (
    !stored ||
    !stored.snapshot.channelId ||
    stored.snapshot.state !== SESSION_STATES.OPEN ||
    stored.pending ||
    stored.recoverable
  )
    return null;
  const terms = stored.terms;
  if (
    terms.sellerNodeId !== seller.nodeId ||
    terms.owner !== seller.owner ||
    terms.buyer !== policy.payer ||
    terms.mint !== policy.mint ||
    terms.network !== policy.network ||
    terms.expiresAt <= now
  )
    return null;
  const remaining =
    BigInt(terms.depositAtomic) -
    BigInt(stored.snapshot.cumulativeAtomic) -
    BigInt(stored.snapshot.reservedAtomic);
  return remaining > 0n ? String(remaining) : null;
}
export async function channelFundingRemaining(
  environment: HomeEnvironment,
  policy: BuyerApiPolicy,
  seller: BuyerSellerChoice,
) {
  const entries = await inspectBatchPool(batchPoolPathsIn(environment), {
    includeLegacy: false,
  });
  if (entries.length) {
    // A durable intent on any seller can block the whole pool until reconciled.
    if (
      entries.some(
        (entry) =>
          !entry.ready ||
          !entry.stored ||
          entry.uncertain ||
          entry.requestId !== null ||
          entry.stored.pending ||
          entry.stored.recoverable,
      )
    )
      return null;
    const match = entries.find(
      (entry) => entry.terms.sellerNodeId === seller.nodeId,
    );
    return available(match?.stored, policy, seller, Date.now());
  }
  const root = await inspectBatchSession(
    batchSessionPathsIn(environment, P2P_ROLES.BUYER),
  );
  return available(root, policy, seller, Date.now());
}
