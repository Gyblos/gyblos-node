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
import type { Engine, RecountTokenizer } from '@gyblos/protocol/engine';

import type { ControlOffer, ControlOffers } from './control-offers';
import type { FreeSellerOffer } from './seller-offer';

export interface SellerOfferObservation {
  // Background renewal; onAvailable runs after a check leaves the offer valid and idle.
  start(onAvailable?: () => Promise<unknown>): void;
  stop(): Promise<void>;
}

export interface LiveSellerOffer extends ControlOffer {
  // Position in gyblos.toml [[offers]].
  index: number;
  offer: FreeSellerOffer;
  // The readiness-tracking engine: generation marks this offer busy.
  engine: Engine;
  tokenizer: RecountTokenizer;
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
  // observations change.
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
    }
    return { members, states };
  }
}
