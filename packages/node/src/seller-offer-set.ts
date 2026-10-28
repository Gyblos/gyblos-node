// The seller's warmed offers and which of them its catalog lists. An offer is listed while its own
// readiness is observed and valid, and stays listed while it renews; one that fails leaves until it is
// warmed again. The catalog's readiness is busy only when every listed offer is busy, valid until the
// earliest listed validity, and its generation moves only when membership or an observation changes,
// so one offer's generation activity never makes the catalog stale. With one offer it equals that
// offer's readiness in everything but the generation number.
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import type { Engine, RecountTokenizer } from '@gyblos/protocol/engine';

import {
  sameSelection,
  type ControlOffer,
  type ControlOffers,
} from './control-offers';
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
// A renewal check holds the offer busy with no validity until it settles.
const renewing = (state: QuoteReadiness, now: number) =>
  state.observedAt <= now && state.busy && state.validUntil === 0;

export class SellerOfferSet implements ControlOffers {
  private readonly offers: LiveSellerOffer[] = [];
  private members = new Set<number>();
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
    return this.observe().map(({ offer }) => offer);
  }

  readiness(): QuoteReadiness {
    const now = this.now();
    const members = this.observe();
    const current = members.filter(({ state }) => valid(state, now));
    // With nothing listed, the latest observation of any offer, as one offer's own readiness reports.
    const observed = members.length
      ? members.map(({ state }) => state.observedAt)
      : this.offers.map((offer) => offer.readiness().observedAt);
    return {
      generation: this.generation,
      busy: members.length > 0 && members.every(({ state }) => state.busy),
      observedAt: Math.max(0, ...observed),
      validUntil: current.length
        ? Math.min(...current.map(({ state }) => state.validUntil))
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

  // Reads every offer once and updates membership; the generation moves when the listed offers or one
  // of their observations change.
  private observe() {
    if (this.stopped) return [];
    const now = this.now();
    const members = this.offers
      .map((offer) => ({ offer, state: offer.readiness() }))
      .filter(
        ({ offer, state }) =>
          valid(state, now) ||
          (renewing(state, now) && this.members.has(offer.index)),
      );
    this.members = new Set(members.map(({ offer }) => offer.index));
    const key = members
      .map(({ offer, state }) => `${offer.index}:${state.observedAt}`)
      .join(',');
    if (key !== this.key) {
      this.key = key;
      this.generation++;
    }
    return members;
  }
}
