// Discard obsolete balance reads when the selected offer or buyer changes.
import { useEffect, useRef, useState } from 'react';

import type { BuyerFunding } from '../funding/model';

export function useBuyerFunding(
  payer?: string,
  offerId?: string,
  enabled = true,
) {
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    payer?: string;
    offerId?: string;
    attempt: number;
    generation: number;
    funding: BuyerFunding | null;
  }>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const readGeneration = generation.current;
    setSnapshot(undefined);
    async function read() {
      let funding: BuyerFunding | null;
      try {
        funding = (await window.desktopFunding?.balance(offerId)) ?? null;
        if (payer && funding?.payer !== payer) funding = null;
      } catch {
        funding = null;
      }
      if (active)
        setSnapshot({
          payer,
          offerId,
          attempt,
          generation: readGeneration,
          funding,
        });
    }
    void read();
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [payer, offerId, attempt, enabled]);
  const current =
    enabled &&
    snapshot &&
    snapshot.payer === payer &&
    snapshot.offerId === offerId &&
    snapshot.attempt === attempt &&
    snapshot.generation === generation.current;
  return {
    loading: !current,
    funding: current ? snapshot.funding : null,
    refresh: () => setAttempt((n) => n + 1),
  };
}
