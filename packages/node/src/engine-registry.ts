// Seller engines by kind. With each plugin's factory, the only place that knows plugin names; a kind
// without a plugin is an unsupported engine.
import { ENGINE_KINDS, type EngineKind } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import type {
  EngineFactory,
  EngineOfferRefusal,
  PreparedEngine,
  SellerEngineOffer,
} from './engine-factory';
import { OLLAMA_ENGINE_FACTORY } from './engine-registry-ollama';
import { NodeError } from './errors';

export const ENGINE_REGISTRY = {
  [ENGINE_KINDS.OLLAMA]: OLLAMA_ENGINE_FACTORY,
} as const satisfies Partial<Record<EngineKind, EngineFactory>>;

const FACTORIES: Partial<Record<EngineKind, EngineFactory>> = ENGINE_REGISTRY;

export function engineOfferRefusal(
  offer: SellerEngineOffer,
): EngineOfferRefusal | undefined {
  const factory = FACTORIES[offer.engine.kind];
  return factory
    ? factory.refuse(offer)
    : NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED;
}

// Settings already refused unservable offers; this guards callers that skip them.
export function createSellerEngine(
  offer: SellerEngineOffer,
  dependencies: { fetch: typeof fetch },
): PreparedEngine {
  const factory = FACTORIES[offer.engine.kind];
  const refusal = engineOfferRefusal(offer);
  if (refusal || !factory)
    throw new NodeError(
      refusal ?? NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED,
      { offer: offer.index },
    );
  return factory.create(offer, dependencies);
}
