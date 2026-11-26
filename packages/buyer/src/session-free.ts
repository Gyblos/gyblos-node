import type { BuyerRoutePorts } from '@gyblos/node/buyer-routing';

import { executeApiKeyFree, type reserveApiKey } from './api-key-execution';
import { executeSelectedBuyerFree } from './free-execution';
import type { ChatResult } from './free-sse';
import type { BuyerExecutionFactory } from './free-startup';
import type { makeManager } from './session-manager';

type Context = Parameters<BuyerExecutionFactory>[0];

export function freeSessionExecution(
  context: Context,
  manager: ReturnType<typeof makeManager>,
  input: Parameters<Awaited<ReturnType<BuyerExecutionFactory>>['execute']>[0],
  permission: Parameters<typeof reserveApiKey>[0],
  onDelta: Parameters<Awaited<ReturnType<BuyerExecutionFactory>>['execute']>[2],
  onUnfit: () => void,
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
      ),
    );
}
