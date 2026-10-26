// Orchestrates free quote execution with failover only before possible prompt transmission.
// Selection and I/O are injected; this module never authorizes payments or records content.
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { buildFreeExecutionRequest, type FreeExecutionBuildInput, type FreeExecutionRequest, type FreeExecutionResult } from '@gyblos/protocol/free-execution';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { FREE_BUYER, FREE_BUYER_CODES } from './constants.js';
import { FreeBuyerError } from './free-chat.js';

export interface FreeWinner { nodeId: string; quote: SignedOfferV2 }
export interface FreeBuyerDependencies {
  select(excluded: ReadonlySet<string>, signal: AbortSignal): Promise<FreeWinner>;
  execute(winner: FreeWinner, request: FreeExecutionRequest, signal: AbortSignal): Promise<FreeExecutionResult>;
}
export async function executeBuyerFree(input: FreeExecutionBuildInput, dependencies: FreeBuyerDependencies, external?: AbortSignal) {
  const signal = AbortSignal.any([AbortSignal.timeout(FREE_BUYER.requestMs), ...(external ? [external] : [])]);
  const excluded = new Set<string>();
  while (!signal.aborted) {
    const winner = await dependencies.select(excluded, signal);
    signal.throwIfAborted();
    if (excluded.has(winner.nodeId)) throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
    excluded.add(winner.nodeId);
    const request = buildFreeExecutionRequest(winner.quote, input);
    try {
      return await dependencies.execute(winner, request, signal);
    } catch (error) {
      if (!(error instanceof FreeClientError) || error.sent || signal.aborted) throw error;
    }
  }
  throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
}
