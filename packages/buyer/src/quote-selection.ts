import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import {
  buyerQuoteKind,
  type BuyerQuoteWinner,
} from '@gyblos/node/buyer-quote-execution';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import type { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { BUYER_SELECTION, FREE_BUYER } from './constants';
import { AfterFreeDispatch } from './free-chat-error';
import { FreeSelectionFailure, unfitOutcome } from './free-execution';
import type { SelectionRoute } from './free-route';
import type { BuyerSelectionConfig } from './selection-config';
import { unaffordableSessionQuote } from './session-errors';

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

export async function selectAffordableAutoQuote<
  Winner extends BuyerQuoteWinner,
>(
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
  select: (excluded: Set<string>) => Promise<Winner>,
  preflight: (quote: Winner['quote']) => Promise<void>,
): Promise<Winner> {
  const skipped = new Set(excluded);
  let budgetFailure: Error | undefined;
  for (;;) {
    signal.throwIfAborted();
    let winner: Winner;
    try {
      winner = await select(skipped);
    } catch (error) {
      signal.throwIfAborted();
      if (budgetFailure && error instanceof FreeSelectionFailure)
        throw budgetFailure;
      throw error;
    }
    signal.throwIfAborted();
    if (budgetFailure && skipped.has(winner.nodeId)) throw budgetFailure;
    if (buyerQuoteKind(winner.quote) === OFFER_PRICING_KINDS.FREE)
      return winner;
    try {
      await preflight(winner.quote);
      signal.throwIfAborted();
      return winner;
    } catch (error) {
      signal.throwIfAborted();
      if (!unaffordableSessionQuote(error)) throw error;
      skipped.add(winner.nodeId);
      if (skipped.size - excluded.size >= BUYER_SELECTION.maxSellers)
        throw error;
      budgetFailure = error;
    }
  }
}

export function delegatedFreeResends(enabled: boolean) {
  let retries = 0;
  let pending = false;
  let failure: FreeClientError | undefined;
  return {
    request: (request: Request) =>
      failure ? openDiscoveryRequest(request) : request,
    failure: () => failure,
    takeFreeResend() {
      const allowed = pending;
      pending = false;
      return allowed;
    },
    selectionError(error: unknown, unfit = false) {
      if (!failure) return unfit ? unfitOutcome(error) : error;
      const outcome = unfitOutcome(error, failure);
      return outcome === failure ? failure : new AfterFreeDispatch(outcome);
    },
    get onResend() {
      if (!enabled || retries >= FREE_BUYER.maxResends) return undefined;
      return (error: FreeClientError) => {
        failure = error;
        pending = true;
        retries++;
      };
    },
  };
}
