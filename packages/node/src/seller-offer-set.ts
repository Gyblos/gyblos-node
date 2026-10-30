// The seller's warmed offers and which of them its catalog lists: exactly those whose own readiness is
// observed and valid now. An offer that renews or fails leaves the listing and returns only with a new
// valid observation, so a signed catalog never names an offer that is not ready. The catalog's readiness
// is busy only when every listed offer is busy (or, with none listed, when one is checking), valid until
// the earliest listed validity, and its generation moves only when membership or an observation
// changes, so one offer's generation activity never makes the catalog stale. With one offer it equals
// that offer's readiness in everything but the generation number.
import {
  sameSelection,
  type QuoteReadiness,
} from '@gyblos/core/control-quotes';
import type { Engine } from '@gyblos/protocol/engine';

import type { ControlOffer, ControlOffers } from './control-offers';
import type { FreeMeter } from './free-meter';
import type { SellerCatalogOffer } from './seller-offer';

export interface SellerOfferObservation {
  // Background renewal; onAvailable runs after a check leaves the offer valid and idle.
  start(onAvailable?: () => Promise<unknown>): void;
  stop(): Promise<void>;
}

export interface LiveSellerOffer extends ControlOffer {
  // Position in gyblos.toml [[offers]].
  index: number;
  offer: SellerCatalogOffer;
  // The readiness-tracking engine: generation marks this offer busy.
  engine: Engine;
  meter: FreeMeter;
  observation: SellerOfferObservation;
}

const valid = (state: QuoteReadiness, now: number) =>
  state.observedAt <= now && state.validUntil > now;

export class SellerOfferSet implements ControlOffers {
  private readonly offers: LiveSellerOffer[] = [];
  private key = '';
  private generation = 0;
  private stopped = false;
  private onAvailable: (() => Promise<unknown>) | undefined;
  private running = false;
  constructor(private readonly now: () => number = Date.now) {}

  add(offer: LiveSellerOffer) {
    if (
      this.offers.some(
        (held) =>
          held.index === offer.index ||
          sameSelection(held.selection, offer.selection),
      )
    )
      throw new Error('Seller offer added twice.');
    this.offers.push(offer);
    this.offers.sort((left, right) => left.index - right.index);
    if (this.running) offer.observation.start(this.onAvailable);
  }

  all(): readonly LiveSellerOffer[] {
    return [...this.offers];
  }

  listed(): readonly LiveSellerOffer[] {
    return this.observe(this.now()).members.map(({ offer }) => offer);
  }

  readiness(): QuoteReadiness {
    const { members, states } = this.observe(this.now());
    // With nothing listed, as one offer's own readiness reports: busy while a check runs, and its
    // latest observation.
    const considered = members.length ? members : states;
    return {
      generation: this.generation,
      busy: members.length
        ? members.every(({ state }) => state.busy)
        : states.some(({ state }) => state.busy),
      observedAt: Math.max(
        0,
        ...considered.map(({ state }) => state.observedAt),
      ),
      validUntil: members.length
        ? Math.min(...members.map(({ state }) => state.validUntil))
        : 0,
    };
  }

  start(onAvailable: () => Promise<unknown>) {
    if (this.stopped || this.running) return;
    this.running = true;
    this.onAvailable = onAvailable;
    for (const offer of this.offers) offer.observation.start(onAvailable);
  }

  async stop() {
    this.stopped = true;
    this.running = false;
    await Promise.all(this.offers.map((offer) => offer.observation.stop()));
  }

  // Reads every offer once at one instant; the generation moves when the listed offers or one of their
  // observations change. Once started, a change re-signs at once, so the first query to see the old
  // catalog stale is the only one: an offer that starts renewing never stalls the others until a tick.
  private observe(now: number) {
    if (this.stopped) return { members: [], states: [] };
    const states = this.offers.map((offer) => ({
      offer,
      state: offer.readiness(),
    }));
    const members = states.filter(({ state }) => valid(state, now));
    const key = members
      .map(({ offer, state }) => `${offer.index}:${state.observedAt}`)
      .join(',');
    if (key !== this.key) {
      this.key = key;
      this.generation++;
      const changed = this.running ? this.onAvailable : undefined;
      // After the caller's own read; a refused re-sign is retried at the next change or tick.
      if (changed) queueMicrotask(() => void changed().catch(() => {}));
    }
    return { members, states };
  }
}
