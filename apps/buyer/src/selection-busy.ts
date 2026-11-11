// Opt-in semantic busy result for a fixed seller; diagnostics and ordinary selection remain unchanged.
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import {
  selectVerifiedBuyerQuote,
  type VerifiedSelectionDependencies,
} from './selection';
import type { BuyerSelectionConfig } from './selection-config';

export interface BusySelectionDependencies extends VerifiedSelectionDependencies {
  onPinnedBusy?: (nodeId: string) => never;
}
export async function selectBusyAwareBuyerQuote(
  config: BuyerSelectionConfig,
  dependencies: BusySelectionDependencies,
  signal?: AbortSignal,
) {
  if (!dependencies.onPinnedBusy || !config.pinnedNodeId)
    return selectVerifiedBuyerQuote(config, dependencies, signal);
  let busy = false;
  const result = await selectVerifiedBuyerQuote(
    config,
    {
      ...dependencies,
      connect: async (seller) => {
        const client = await dependencies.connect(seller);
        return {
          getCatalog: (...args) => client.getCatalog(...args),
          getPresence: (...args) => client.getPresence(...args),
          close: () => client.close(),
          requestOffer: async (...args) => {
            try {
              return await client.requestOffer(...args);
            } catch (error) {
              if (
                seller.nodeId === config.pinnedNodeId &&
                error instanceof ControlError &&
                error.code === CONTROL_CODES.BUSY
              )
                busy = true;
              throw error;
            }
          },
        };
      },
    },
    signal,
  );
  if (!result.ok && busy && !signal?.aborted)
    dependencies.onPinnedBusy(config.pinnedNodeId);
  return result;
}
