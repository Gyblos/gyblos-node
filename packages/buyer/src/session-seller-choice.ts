// Restrict a single owner-authenticated chat to the verified seller and terms that were selected.
import { UnsentSellerChoiceError } from '@gyblos/node/buyer-session';
import type { BuyerSellerChoice } from '@gyblos/protocol/buyer-api';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { primaryRelayUrl } from '@gyblos/transport-iroh/endpoint';

import type { FreeWinner } from './free-execution';
import type { SelectionRoute } from './free-route';
import type { PreparedSelection } from './free-selection';
import { selectForSettledPartial } from './quote-selection';

export function prepareChosenSeller(
  prepared: PreparedSelection,
  choice: BuyerSellerChoice,
) {
  const { config } = prepared;
  if (config.request.maxAtomic === '0')
    throw new UnsentSellerChoiceError(SESSION_CODES.LIMIT);
  if (
    !prepared.identity ||
    !prepared.discovery ||
    !config.session ||
    choice.expiresAt <= Date.now() ||
    (config.pinnedNodeId && config.pinnedNodeId !== choice.nodeId)
  )
    throw new UnsentSellerChoiceError(SESSION_CODES.BINDING);
  const known = config.sellers.find(
    (seller) => seller.nodeId === choice.nodeId,
  );
  if (
    (known && known.owner !== choice.owner) ||
    (!known && !config.discovery?.open)
  )
    throw new UnsentSellerChoiceError(SESSION_CODES.UNVERIFIED);
  const seller = known ?? {
    owner: choice.owner,
    nodeId: choice.nodeId,
    relayUrl: primaryRelayUrl(),
    directAddresses: [],
    manualTrust: false,
  };
  return {
    seller,
    prepared: {
      ...prepared,
      config: { ...config, sellers: [seller], pinnedNodeId: seller.nodeId },
    },
  };
}
export function verifyChosenOffer(
  choice: BuyerSellerChoice,
  winner: FreeWinner,
) {
  const { offer } = winner.quote;
  if (
    choice.expiresAt <= Date.now() ||
    winner.nodeId !== choice.nodeId ||
    offer.nodeId !== choice.nodeId ||
    offer.owner !== choice.owner ||
    offer.selection.modelId !== choice.modelId ||
    offer.selection.variant !== choice.variant ||
    offer.selection.quantization !== choice.quantization ||
    offer.model.contextTokens !== choice.contextTokens ||
    offer.prices.inputAtomicPerMtok !== choice.inputAtomicPerMtok ||
    offer.prices.outputAtomicPerMtok !== choice.outputAtomicPerMtok
  )
    throw new UnsentSellerChoiceError(SESSION_CODES.BINDING);
}

export async function selectForChannel<Winner>(
  config: PreparedSelection['config'],
  candidate: PreparedSelection['config']['request'],
  selectionRoute: SelectionRoute | undefined,
  previousSeller: () => Promise<
    { nodeId: string; partial: boolean } | undefined
  >,
  excluded: ReadonlySet<string>,
  current: AbortSignal,
  pick: (
    request: PreparedSelection['config']['request'],
    route?: SelectionRoute,
  ) => Promise<Winner>,
) {
  if (!config.discovery?.paidAuto || candidate.maxAtomic === '0')
    return pick(candidate, selectionRoute);
  const previous = await previousSeller();
  if (previous?.partial)
    return selectForSettledPartial(
      candidate,
      {
        pinnedNodeId: config.pinnedNodeId,
        open: config.discovery.open,
        ...selectionRoute,
      },
      previous.nodeId,
      excluded,
      current,
      pick,
    );
  return pick(
    candidate,
    selectionRoute?.open && !selectionRoute.previousSeller
      ? { ...selectionRoute, previousSeller: previous?.nodeId }
      : selectionRoute,
  );
}
