// Paid execution over the seller's warmed paid offers: one service per offer (its engine, recount meter
// and readiness), all on the seller's one paid ledger and payment server, behind the paid router. An
// offer's service is built once, so it survives while the offer is listed, unlisted and listed again.
import type { PaidSellerLedger } from '@gyblos/core/paid-admission';
import {
  OFFER_PRICING_KINDS,
  type EngineKind,
} from '@gyblos/protocol/constants';
import type { PaymentServer } from '@gyblos/protocol/payment';
import type { PaidExecutionService } from '@gyblos/transport-iroh/paid-server';

import {
  createSellerPaidExecution,
  type SellerPaidExecutionOptions,
} from './paid-execution';
import { createSellerPaidRouter, type PaidOffer } from './paid-router';
import type { PaidSettlementOptions } from './paid-settlement';
import type { PaidSellerOffer } from './seller-offer';
import type { LiveSellerOffer } from './seller-offer-set';

export interface SellerPaidOffersOptions {
  telemetry?: Omit<
    NonNullable<SellerPaidExecutionOptions['telemetry']>,
    'engineKind'
  > & {
    engineKind: (index: number) => EngineKind;
  };
  owner: string;
  nodeId: string;
  now: () => number;
  // Created once per seller process: renewals never forget a spent request id.
  ledger: PaidSellerLedger;
  payment: PaymentServer;
  settlement: PaidSettlementOptions;
}

type PaidLiveOffer = LiveSellerOffer & { offer: PaidSellerOffer };
const isPaid = (live: LiveSellerOffer): live is PaidLiveOffer =>
  live.offer.kind === OFFER_PRICING_KINDS.PAID;

// Reads the paid offers on every request, so an offer warmed later is served from then on.
export function createSellerPaidOffers(
  offers: () => readonly LiveSellerOffer[],
  options: SellerPaidOffersOptions,
): PaidExecutionService {
  const services = new Map<number, PaidOffer>();
  const serve = (live: PaidLiveOffer) => {
    const held = services.get(live.index);
    if (held) return held;
    const created: PaidOffer = {
      selection: live.selection,
      service: createSellerPaidExecution({
        ...options,
        telemetry: options.telemetry
          ? {
              ...options.telemetry,
              engineKind: options.telemetry.engineKind(live.index),
            }
          : undefined,
        reasoning: live.offer.reasoning,
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
  return createSellerPaidRouter(() => offers().filter(isPaid).map(serve));
}
