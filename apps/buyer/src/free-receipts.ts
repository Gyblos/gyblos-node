// Observes verified buyer output and submits metadata only; receipt failure is outside prompt retry policy.
import { receiptTextSizes } from '@gyblos/core/receipts';
import {
  freeExecutionDigest,
  type FreeExecutionRequest,
  type FreeExecutionResult,
} from '@gyblos/protocol/free-execution';

import type { FreeBuyerDependencies, FreeWinner } from './free-execution';

export function buyerReceiptObservation(
  dependencies: FreeBuyerDependencies,
  streaming: boolean,
) {
  if (!dependencies.receipt) return undefined;
  try {
    const clock = dependencies.receiptNow ?? (() => performance.now());
    const start = clock();
    let first: number | null = null;
    let usable = true;
    return {
      text(text: string) {
        try {
          if (text && first === null) first = Math.floor(clock() - start);
        } catch {
          usable = false;
        }
      },
      async finish(
        winner: FreeWinner,
        request: FreeExecutionRequest,
        result: FreeExecutionResult,
        signal: AbortSignal,
      ) {
        try {
          if (!usable) return;
          const offer = request.quote.offer;
          const totalMs = Math.floor(clock() - start);
          const outputBytes = receiptTextSizes('', result.text).outputBytes;
          await dependencies.receipt?.(
            winner,
            {
              context: {
                requestId: request.requestId,
                requestDigest: await freeExecutionDigest(request),
                sellerNodeId: offer.nodeId,
                buyerNodeId: offer.buyerNodeId,
                owner: offer.owner,
                selection: offer.selection,
                reasoning: offer.reasoning,
                streaming,
              },
              observed: {
                inputTokens: null,
                outputTokens: null,
                outputBytes,
                firstTokenMs: outputBytes ? (first ?? totalMs) : null,
                totalMs,
              },
            },
            signal,
          );
        } catch {
          /* A receipt cannot change a completed inference or enter failover. */
        }
      },
    };
  } catch {
    return undefined;
  }
}
