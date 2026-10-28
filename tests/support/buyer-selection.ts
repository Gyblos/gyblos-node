// Composes synthetic signed control sellers for buyer routing tests, never production state.
import { createBuyerControlClient } from '@gyblos/buyer/control';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';

import { controlFixture } from './control-fixture';
import { controlLoopback } from './control-loopback';

export async function selectionFixture() {
  const source = await controlFixture();
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  const wire = await controlLoopback(
    service,
    source.request.params.buyerNodeId,
  );
  const client = createBuyerControlClient(
    { ...wire.transport, remoteNodeId: source.catalog.nodeId },
    { ...source.trust(), now: source.context.now },
  );
  const {
    buyer: _buyer,
    buyerNodeId: _node,
    catalogDigest: _digest,
    ...request
  } = source.request.params;
  const config: BuyerSelectionConfig = {
    request: {
      ...request,
      lowestReasoning: null,
      minimumBadge: SELLER_BADGES.DECLARED_USAGE,
      retention: [source.catalog.dataPolicy.retention],
    },
    sellers: [
      {
        owner: source.catalog.owner,
        nodeId: source.catalog.nodeId,
        relayUrl: null,
        directAddresses: [],
      },
    ],
  };
  const dependencies = {
    connect: async () => client,
    buyer: source.request.params.buyer,
    trusted: source.catalog,
    stats: new Map<string, LocalSellerStats>(),
    now: source.context.now,
    random: () => 0,
    windowMs: 2000,
  };
  return { ...source, service, wire, client, config, dependencies };
}
