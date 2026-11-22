import type { TokenPricesV2 } from '@gyblos/protocol/control-types';

import { parseBuyerSelectionConfig } from './selection-config';

export class AutoSettingsError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AutoSettingsError('Invalid buyer settings.');
  return Object.fromEntries(Object.entries(value));
}

export function withAutoPrices(value: unknown, prices: TokenPricesV2 | null) {
  const config = parseBuyerSelectionConfig(value);
  if (!config.discovery?.open || config.sellers.length || config.pinnedNodeId)
    throw new AutoSettingsError(
      'Auto needs an open-discovery buyer without a pinned or configured seller.',
    );
  if (prices && (!config.session || config.request.maxAtomic === '0'))
    throw new AutoSettingsError(
      'Set a positive maximum per response and a channel policy before enabling paid Auto.',
    );
  const raw = record(value);
  const discovery = record(raw.discovery);
  if (!prices) delete discovery.paidAuto;
  else discovery.paidAuto = true;
  const next = {
    ...raw,
    discovery,
    ...(prices && {
      request: { ...record(raw.request), priceCeilings: prices },
    }),
  };
  parseBuyerSelectionConfig(next);
  return next;
}
