// Restrict a single owner-authenticated chat to the verified seller and terms that were selected.
import { BUYER_SESSION_DEFAULT_POLICY } from '@gyblos/config/batch-session';
import type { BuyerSellerChoice } from '@gyblos/protocol/buyer-api';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import { primaryRelayUrl } from '@gyblos/transport-iroh/endpoint';

import type { FreeWinner } from './free-execution';
import type { PreparedSelection } from './free-selection';

export function prepareChosenSeller(
  prepared: PreparedSelection,
  choice: BuyerSellerChoice,
) {
  const { config } = prepared;
  if (
    config.request.maxAtomic === '0' ||
    !prepared.identity ||
    !prepared.discovery ||
    !config.session ||
    config.session.depositAtomic !==
      BUYER_SESSION_DEFAULT_POLICY.depositAtomic ||
    config.session.lifetimeMs !== BUYER_SESSION_DEFAULT_POLICY.lifetimeMs ||
    choice.expiresAt <= Date.now() ||
    (config.pinnedNodeId && config.pinnedNodeId !== choice.nodeId)
  )
    return sessionFail(SESSION_CODES.BINDING);
  const known = config.sellers.find(
    (seller) => seller.nodeId === choice.nodeId,
  );
  if (
    (known && known.owner !== choice.owner) ||
    (!known && !config.discovery?.open)
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
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
    return sessionFail(SESSION_CODES.BINDING);
}
