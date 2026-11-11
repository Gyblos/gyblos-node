// Supplies fresh signed reference prices to the shared router; no fallback trust or financial operation.
import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import {
  createBuyerRouter,
  UnsentSellerBusyError,
} from '@gyblos/node/buyer-routing';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { sessionFail } from '@gyblos/protocol/payment-session';

import { connectFreeControl } from './free-selection';
import type { BuyerExecutionFactory } from './free-startup';
import { verifyBuyerIdentity } from './identity';
import { verifiedSeller } from './selection';

type Context = Parameters<BuyerExecutionFactory>[0];
export function sessionRouter(
  context: Context,
  unresolved: () => Promise<boolean>,
) {
  const { prepared, endpoint, relayOnly, role } = context;
  if (role.role !== P2P_ROLES.BUYER) return sessionFail();
  const buyer = role.buyer;
  return createBuyerRouter({
    policy: parseBuyerRoutingPolicy(prepared.config.routing),
    pinnedNodeId: prepared.config.pinnedNodeId,
    priceCeilings: prepared.config.request.priceCeilings,
    unresolved,
    reference: async (nodeId, signal) => {
      const seller = prepared.config.sellers.find(
        (seller) => seller.nodeId === nodeId,
      );
      if (
        !seller ||
        !(await verifyBuyerIdentity(prepared.identity, seller, signal))
      )
        return undefined;
      const client = await connectFreeControl(
        seller,
        { endpoint, relayOnly, buyer },
        Date.now,
      );
      try {
        const known = await verifiedSeller(client, seller, Date.now, signal);
        if (
          known.withdrawal ||
          !(await verifyBuyerIdentity(prepared.identity, seller, signal))
        )
          return undefined;
        if (prepared.discovery) {
          await prepared.discovery.observe(known, {
            allowOwnerChange: Boolean(prepared.identity),
          });
          if (
            !(await prepared.discovery.permits(
              seller.owner,
              seller.nodeId,
              known.presence!.catalogDigest,
              Date.now(),
            ))
          )
            return undefined;
        }
        const wanted = prepared.config.request;
        const listing = known.catalog.models.find(
          (model) =>
            model.modelId === wanted.selection.modelId &&
            model.variant === wanted.selection.variant &&
            model.quantization === wanted.selection.quantization &&
            model.reasoning.includes(wanted.reasoning) &&
            model.pricing.network === wanted.network &&
            model.pricing.asset === wanted.asset,
        );
        signal.throwIfAborted();
        if (known.catalog.expiresAt <= Date.now()) return undefined;
        return listing?.pricing;
      } finally {
        await client.close();
      }
    },
  });
}
export function pinnedBusy(nodeId: string): never {
  throw new UnsentSellerBusyError(nodeId);
}
