// What control needs from the seller's offers: the ones its catalog lists right now, each with its own
// quote readiness, and the readiness the catalog itself is bound to. Pure types and mappings.
import type { QuoteModel, QuoteReadiness } from '@gyblos/core/control-quotes';
import {
  OFFER_PRICING_KINDS,
  type ControlMeteringMode,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import type {
  EngineCapabilities,
  EngineDescription,
} from '@gyblos/protocol/engine';

import type { SellerCatalogOffer } from './seller-offer';

export interface ControlOffer {
  // From the engine plugin: what the catalog lists and how delivered tokens are counted.
  selection: ModelSelection;
  // The listing: from gyblos.toml in the daemon, chosen by the caller in lab acceptance.
  offer: SellerCatalogOffer;
  // The warmed engine's description, which quotes carry.
  model: EngineDescription;
  capabilities: EngineCapabilities;
  meteringMode: ControlMeteringMode;
  // This offer's own readiness; each quote is bound to it.
  readiness: () => QuoteReadiness;
  // Whether the offer's engine serves tools (free offers only).
  tools?: boolean;
}

export interface ControlOffers {
  // The catalog's models, in listing order; never empty while the catalog is signable.
  listed(): readonly ControlOffer[];
  // What the catalog is bound to: busy only when every listed offer is busy.
  readiness(): QuoteReadiness;
}

// The listing and the engine plugin's selection must name the same model, or the catalog would sign
// one model and quote another; the listing's reasoning was already admitted by the plugin.
export function checkedControlOffer(offer: ControlOffer): ControlOffer {
  if (offer.selection.modelId !== offer.offer.modelId)
    throw new Error('Engine selection does not match the listed model.');
  return offer;
}

// One offer that is always listed; its own readiness gates the catalog, as before several offers.
export function singleControlOffer(offer: ControlOffer): ControlOffers {
  const listed = [checkedControlOffer(offer)];
  return { listed: () => listed, readiness: offer.readiness };
}

export function quoteModel(offer: ControlOffer): QuoteModel {
  return {
    selection: { ...offer.selection },
    model: offer.model,
    capabilities: offer.capabilities,
    reasoning: [...offer.offer.reasoning],
    meteringMode: offer.meteringMode,
    // A free offer refuses a longer answer at quote time, not after the buyer sent its conversation.
    ...(offer.offer.kind === OFFER_PRICING_KINDS.FREE
      ? {
          maxOutputTokens: offer.offer.caps.maxOutputTokens,
          tools: offer.tools === true,
        }
      : {}),
  };
}
