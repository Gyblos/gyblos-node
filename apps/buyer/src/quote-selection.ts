// Which sellers the automatic buyer asks: its configured sellers first, at the request's own ceilings.
// With open discovery, a request no configured seller takes (none configured, or none available) goes to
// the registered sellers the index lists, for free only: automatic paid execution pays configured sellers
// alone.
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';

import { FreeSelectionFailure } from './free-execution';
import type { BuyerSelectionConfig } from './selection-config';

type Request = BuyerSelectionConfig['request'];

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
    {
      ...request,
      maxAtomic: '0',
      priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
    },
    { open: true },
  );
  signal.throwIfAborted();
  return winner;
}
