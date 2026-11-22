import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';

import { FreeSelectionFailure } from './free-execution';
import type { SelectionRoute } from './free-route';
import type { BuyerSelectionConfig } from './selection-config';

type Request = BuyerSelectionConfig['request'];

export function openDiscoveryRequest(
  request: Request,
  paidAuto?: boolean,
): Request {
  return paidAuto && request.maxAtomic !== '0'
    ? request
    : {
        ...request,
        maxAtomic: '0',
        priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
      };
}
export function automaticPoolRoute(
  config: Pick<BuyerSelectionConfig, 'discovery' | 'pinnedNodeId'>,
  route: SelectionRoute,
): SelectionRoute {
  return config.discovery?.paidAuto &&
    !config.pinnedNodeId &&
    (!route.pinnedNodeId || route.waitingFor === route.pinnedNodeId)
    ? { ...route, open: true }
    : route;
}

export async function selectConfiguredThenOpen<Winner>(
  config: Pick<BuyerSelectionConfig, 'sellers' | 'discovery'>,
  request: Request,
  signal: AbortSignal,
  select: (request: Request, route?: { open: true }) => Promise<Winner>,
): Promise<Winner> {
  signal.throwIfAborted();
  const open = config.discovery?.open === true;
  if (config.sellers.length)
    try {
      const winner = await select(request);
      signal.throwIfAborted();
      return winner;
    } catch (error) {
      if (!open || signal.aborted || !(error instanceof FreeSelectionFailure))
        throw error;
    }
  if (!open)
    throw new FreeSelectionFailure({
      ok: false,
      code: SELLER_SELECTION_CODES.NO_CANDIDATES,
    });
  signal.throwIfAborted();
  const winner = await select(
    openDiscoveryRequest(request, config.discovery?.paidAuto),
    { open: true },
  );
  signal.throwIfAborted();
  return winner;
}
