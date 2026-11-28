import {
  fallbackPriceCeilings,
  type BuyerRoutingPolicy,
} from '@gyblos/core/buyer-routing';
import { buyerQuoteKind } from '@gyblos/node/buyer-quote-execution';
import type { BuyerRoutePorts } from '@gyblos/node/buyer-routing';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import { executeApiKeyFree, type reserveApiKey } from './api-key-execution';
import { executeSelectedBuyerFree } from './free-execution';
import type { ChatResult } from './free-sse';
import type { BuyerExecutionFactory } from './free-startup';
import { fittedAnswer } from './input-size';
import type { delegatedFreeResends } from './quote-selection';
import type { makeManager } from './session-manager';

type Context = Parameters<BuyerExecutionFactory>[0];

export function freeSessionExecution(
  context: Context,
  manager: ReturnType<typeof makeManager>,
  input: Parameters<Awaited<ReturnType<BuyerExecutionFactory>>['execute']>[0],
  permission: Parameters<typeof reserveApiKey>[0],
  onDelta: Parameters<Awaited<ReturnType<BuyerExecutionFactory>>['execute']>[2],
  onUnfit: () => void,
  retries: ReturnType<typeof delegatedFreeResends>,
): BuyerRoutePorts<ChatResult>['free'] {
  return (winner, current, sending) =>
    executeApiKeyFree(permission, winner.quote, current, () =>
      executeSelectedBuyerFree(
        input,
        context.dependencies,
        winner,
        current,
        onDelta,
        () => {
          if ('checkBeforeExternalExecution' in manager)
            manager.checkBeforeExternalExecution();
          sending?.();
        },
        onUnfit,
        retries.onResend,
      ),
    );
}

export function fittingSelect(
  select: BuyerRoutePorts<ChatResult>['select'],
  input: FreeExecutionBuildInput,
  onUnfit: () => void,
  policy: BuyerRoutingPolicy,
): BuyerRoutePorts<ChatResult>['select'] {
  return async (excluded, current, first) => {
    const skip = new Set(excluded);
    let route = first;
    for (;;) {
      const winner = await select(skip, current, route);
      if (
        skip.has(winner.nodeId) ||
        buyerQuoteKind(winner.quote) !== OFFER_PRICING_KINDS.FREE ||
        fittedAnswer(input, winner.quote.offer) !== undefined
      )
        return winner;
      onUnfit();
      skip.add(winner.nodeId);
      route = {
        ...route,
        priceCeilings:
          fallbackPriceCeilings(
            policy,
            winner.quote.offer.prices,
            route.priceCeilings,
          ) ?? route.priceCeilings,
      };
    }
  };
}
