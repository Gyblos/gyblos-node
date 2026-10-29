// Free execution over the seller's warmed offers: one service per offer (its engine, meter, readiness
// and token caps), all on the seller's one ledger, behind the free router. An offer's service is built
// once, so its caps survive while it is listed, unlisted and listed again.
import type { FreeSellerLedger } from '@gyblos/core/free-admission';
import type { EngineKind } from '@gyblos/protocol/constants';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';

import { createSellerFreeExecution } from './free-execution';
import {
  createSellerFreeRouter,
  type FreeOffer,
  type FreeOfferService,
} from './free-router';
import type { SellerReceiptPublisher } from './receipt-seller';
import type { LiveSellerOffer } from './seller-offer-set';

export interface SellerFreeOffersOptions {
  receipts?: {
    publisher: SellerReceiptPublisher;
    engineKind: (index: number) => EngineKind;
  };
  telemetry?: {
    sink: TelemetrySink;
    engineKind: (index: number) => EngineKind;
    now?: () => number;
  };
  owner: string;
  nodeId: string;
  now: () => number;
  // Created once per seller process: renewals never reset single use or the day's buyers.
  ledger: FreeSellerLedger;
}

// Reads the offers on every request, so an offer warmed later is served from then on.
export function createSellerFreeOffers(
  offers: () => readonly LiveSellerOffer[],
  options: SellerFreeOffersOptions,
): FreeOfferService {
  const services = new Map<number, FreeOffer>();
  const serve = (live: LiveSellerOffer) => {
    const held = services.get(live.index);
    if (held) return held;
    const created: FreeOffer = {
      selection: live.selection,
      service: createSellerFreeExecution({
        ...options,
        telemetry: options.telemetry
          ? {
              ...options.telemetry,
              engineKind: options.telemetry.engineKind(live.index),
            }
          : undefined,
        receipts: options.receipts
          ? {
              publisher: options.receipts.publisher,
              engineKind: options.receipts.engineKind(live.index),
            }
          : undefined,
        offer: live.offer,
        selection: live.selection,
        model: live.model,
        capabilities: live.capabilities,
        engine: live.engine,
        meter: live.meter,
        readiness: live.readiness,
      }),
    };
    services.set(live.index, created);
    return created;
  };
  return createSellerFreeRouter(() => offers().map(serve));
}
