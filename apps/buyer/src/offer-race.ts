// Races already selected candidates before authorization, preserving exact-level priority.
// No payment, transport retries, persistence or seller selection belongs here.
import type { SellerCandidate } from '@gyblos/core/seller-selection';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';

import { BUYER_SELECTION } from './constants';

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
  options: {
    signal?: AbortSignal;
    windowMs?: number;
    // Called once, before the race resolves, with the candidates still unanswered when the window closed.
    onExpired?: (pending: readonly SellerCandidate[]) => void;
    // The seller that served this conversation before, whose prompt cache may still be warm: another
    // exact quote waits up to `preferMs` for it, and its own quote wins at once.
    preferred?: string;
    preferMs?: number;
  } = {},
): Promise<WinningQuote | undefined> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let exactPending = candidates.filter((item) => !item.downgrade).length;
    let pending = candidates.length;
    let finished = false;
    let lower: WinningQuote | undefined;
    let other: WinningQuote | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // Only an exact-level preferred seller is waited for: a lower level one could not win anyway.
    const preferred = candidates.find(
      (item) => item.nodeId === options.preferred && !item.downgrade,
    );
    const waitsFor = (candidate: SellerCandidate) =>
      preferred !== undefined &&
      candidate !== preferred &&
      unanswered.has(preferred);
    const unanswered = new Set(candidates);
    const finish = (winner?: WinningQuote) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
      resolve(winner);
    };
    const abort = () => finish();
    // A timed-out exact candidate is still unresolved: never choose a buffered downgrade then.
    const timer = setTimeout(() => {
      // A quote waiting for the preferred seller ends the race as the first quote did before: the sellers
      // still silent are let go, not cooled down.
      if (!finished && !other) options.onExpired?.([...unanswered]);
      finish(other);
    }, options.windowMs ?? BUYER_SELECTION.windowMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted || !pending) return finish();
    for (const candidate of candidates) {
      void Promise.resolve()
        .then(() => request(candidate, controller.signal))
        .then(
          (quote) => {
            if (finished) return;
            const winner = { candidate, quote };
            if (!candidate.downgrade && waitsFor(candidate)) {
              if (!other) {
                other = winner;
                grace = setTimeout(
                  () => finish(other),
                  options.preferMs ?? BUYER_SELECTION.preferMs,
                );
              }
              return;
            }
            if (!candidate.downgrade) return finish(winner);
            lower ??= winner;
          },
          () => {}, // A refusal is a free preauthorization failure, never a paid retry.
        )
        .then(() => {
          unanswered.delete(candidate);
          if (finished) return;
          pending--;
          if (!candidate.downgrade) exactPending--;
          // The preferred seller refused or failed: the quote that waited for it wins.
          if (other && candidate === preferred) finish(other);
          else if (!exactPending && (other ?? lower)) finish(other ?? lower);
          else if (!pending) finish();
        });
    }
  });
}
