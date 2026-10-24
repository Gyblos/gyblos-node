// Races already selected candidates before authorization, preserving exact-level priority.
// No payment, transport retries, persistence or seller selection belongs here.
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';

import { BUYER_SELECTION } from './constants.js';

export interface WinningQuote {
  candidate: SellerCandidate;
  quote: SignedOfferV2;
}
export function raceControlOffers(
  candidates: readonly SellerCandidate[],
  request: (
    candidate: SellerCandidate,
    signal: AbortSignal,
  ) => Promise<SignedOfferV2>,
  options: { signal?: AbortSignal; windowMs?: number } = {},
): Promise<WinningQuote | undefined> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let exactPending = candidates.filter((item) => !item.downgrade).length;
    let pending = candidates.length;
    let finished = false;
    let lower: WinningQuote | undefined;
    const finish = (winner?: WinningQuote) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
      resolve(winner);
    };
    const abort = () => finish();
    // A timed-out exact candidate is still unresolved: never choose a buffered downgrade then.
    const timer = setTimeout(
      () => finish(),
      options.windowMs ?? BUYER_SELECTION.windowMs,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted || !pending) return finish();
    for (const candidate of candidates) {
      void Promise.resolve()
        .then(() => request(candidate, controller.signal))
        .then(
          (quote) => {
            if (finished) return;
            const winner = { candidate, quote };
            if (!candidate.downgrade) return finish(winner);
            lower ??= winner;
          },
          () => {}, // A refusal is a free preauthorization failure, never a paid retry.
        )
        .then(() => {
          if (finished) return;
          pending--;
          if (!candidate.downgrade) exactPending--;
          if (!exactPending && lower) finish(lower);
          else if (!pending) finish();
        });
    }
  });
}
