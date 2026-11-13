// Supplies fresh signed reference prices to the shared router; no fallback trust or financial operation.
import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import type { SellerRequest } from '@gyblos/core/seller-selection';
import {
  createBuyerRouter,
  UnsentSellerBusyError,
  type BuyerRouteScope,
} from '@gyblos/node/buyer-routing';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  TokenPricesV2,
} from '@gyblos/protocol/control-types';
import { sessionFail } from '@gyblos/protocol/payment-session';

import { connectFreeControl } from './free-selection';
import type { BuyerExecutionFactory } from './free-startup';
import { verifyBuyerIdentity } from './identity';
import { verifiedSeller } from './selection';

type Context = Parameters<BuyerExecutionFactory>[0];
export interface RequestScope extends BuyerRouteScope {
  request: SellerRequest;
}

// The listing one request prices: its exact selection, reasoning, network and asset. A busy seller's
// price reference bounds fallback only for requests with this same key.
export function routeScope(request: SellerRequest): RequestScope {
  const { selection, reasoning, network, asset } = request;
  return {
    key: JSON.stringify([
      selection.modelId,
      selection.variant,
      selection.quantization,
      reasoning,
      network,
      asset,
    ]),
    request,
  };
}

// The prices a current signed catalog lists for exactly this request's listing, else none.
export function referencePrices(
  catalog: Pick<PublicCatalogV2, 'models' | 'expiresAt'>,
  wanted: SellerRequest | undefined,
  now: number,
): TokenPricesV2 | undefined {
  if (!wanted || catalog.expiresAt <= now) return undefined;
  const listing = catalog.models.find(
    (model) =>
      model.modelId === wanted.selection.modelId &&
      model.variant === wanted.selection.variant &&
      model.quantization === wanted.selection.quantization &&
      model.reasoning.includes(wanted.reasoning) &&
      model.pricing.network === wanted.network &&
      model.pricing.asset === wanted.asset,
  );
  return listing
    ? {
        inputAtomicPerMtok: listing.pricing.inputAtomicPerMtok,
        outputAtomicPerMtok: listing.pricing.outputAtomicPerMtok,
      }
    : undefined;
}
export function sessionRouter(
  context: Context,
  unresolved: () => Promise<boolean>,
) {
  const { prepared, endpoint, relayOnly, role } = context;
  if (role.role !== P2P_ROLES.BUYER) return sessionFail();
  const buyer = role.buyer;
  return createBuyerRouter<RequestScope>({
    policy: parseBuyerRoutingPolicy(prepared.config.routing),
    pinnedNodeId: prepared.config.pinnedNodeId,
    priceCeilings: prepared.config.request.priceCeilings,
    unresolved,
    reference: async (nodeId, signal, scope) => {
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
        signal.throwIfAborted();
        return referencePrices(known.catalog, scope?.request, Date.now());
      } finally {
        await client.close();
      }
    },
  });
}
export function pinnedBusy(nodeId: string): never {
  throw new UnsentSellerBusyError(nodeId);
}
