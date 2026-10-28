// Seller engines by kind: settings, doctor and startup refuse and create engines only through this
// registry. A kind without a registered plugin is an unsupported engine.
import { ENGINE_KINDS, type EngineKind } from '@gyblos/protocol/constants';

import { NODE_ERROR_CODES } from './constants';
import type {
  EngineDependencies,
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

// Own keys only, so an unvalidated kind such as __proto__ never resolves to an inherited value.
function engineFactory(kind: EngineKind): EngineFactory | undefined {
  const factories: Partial<Record<string, EngineFactory>> = ENGINE_REGISTRY;
  return Object.hasOwn(factories, kind) ? factories[kind] : undefined;
}

export function engineOfferRefusal(
  offer: SellerEngineOffer,
): EngineOfferRefusal | undefined {
  const factory = engineFactory(offer.engine.kind);
  return factory
    ? factory.refuse(offer)
    : NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED;
}

// Settings already refused unservable offers; this guards callers that skip them.
export function createSellerEngine(
  offer: SellerEngineOffer,
  dependencies: EngineDependencies,
): PreparedEngine {
  const factory = engineFactory(offer.engine.kind);
  if (!factory)
    throw new NodeError(NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED, {
      offer: offer.index,
    });
  const refusal = factory.refuse(offer);
  if (refusal) throw new NodeError(refusal, { offer: offer.index });
  return factory.create(offer, dependencies);
}
