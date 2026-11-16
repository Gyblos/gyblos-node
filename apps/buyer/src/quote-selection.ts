// Which sellers the automatic buyer asks: its configured sellers first, at the request's own ceilings.
// With open discovery, a request no configured seller takes (none configured, or none available) goes to
// the registered sellers the index lists, for free only: paid execution pays configured sellers alone.
import { FreeSelectionFailure } from './free-execution';
import type { BuyerSelectionConfig } from './selection-config';

type Request = BuyerSelectionConfig['request'];

export async function selectConfiguredThenOpen<Winner>(
  config: Pick<BuyerSelectionConfig, 'sellers' | 'discovery'>,
  request: Request,
  signal: AbortSignal,
  select: (request: Request, route?: { open: true }) => Promise<Winner>,
): Promise<Winner> {
  const open = config.discovery?.open === true;
  if (config.sellers.length)
    try {
      return await select(request);
    } catch (error) {
      if (!open || signal.aborted || !(error instanceof FreeSelectionFailure))
        throw error;
    }
  return select(
    {
      ...request,
      maxAtomic: '0',
      priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
    },
    { open: true },
  );
}
