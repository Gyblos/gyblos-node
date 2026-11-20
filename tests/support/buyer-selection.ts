// Composes synthetic signed control sellers for buyer routing tests, never production state.
import { createBuyerControlClient } from '@gyblos/buyer/control';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import {
  BATCH_SESSION_DEFAULTS,
  BUYER_SESSION_DEFAULT_POLICY,
} from '@gyblos/config/batch-session';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';
import type { ControlService } from '@gyblos/transport-iroh/control-server';

import { controlFixture } from './control-fixture';
import { controlLoopback } from './control-loopback';

export async function selectionFixture(
  free = false,
  // Changes the seller's quote context, e.g. its offers' measured reading speed.
  adjust: (
    context: Awaited<ReturnType<typeof controlFixture>>['context'],
  ) => Awaited<ReturnType<typeof controlFixture>>['context'] = (context) =>
    context,
  // Changes the seller's service, e.g. to answer like an older release.
  wrap: (service: ControlService) => ControlService = (service) => service,
) {
  const source = await controlFixture(free);
  const service = wrap(
    createSellerControlService({
      context: adjust(source.context),
      ownerSigner: source.ownerSigner,
      nodeSigner: source.nodeSigner,
    }),
  );
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
    session: {
      ...BUYER_SESSION_DEFAULT_POLICY,
      withdrawDelaySeconds: BATCH_SESSION_DEFAULTS.withdrawDelaySeconds,
    },
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
