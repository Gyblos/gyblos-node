// Discard obsolete balance reads when the selected offer or buyer changes.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { BuyerFunding } from '../funding/model';

export function useBuyerFunding(
  payer?: string,
  offerId?: string,
  enabled = true,
) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    payer?: string;
    offerId?: string;
    attempt: number;
    funding: BuyerFunding | null;
  }>();
  const [enabledBefore, setEnabledBefore] = useState(enabled);
  if (enabledBefore !== enabled) {
    setEnabledBefore(enabled);
    setSnapshot(undefined);
  }
  const generation = useRef(0);
  const verify = useCallback(async () => {
    const id = ++generation.current;
    setSnapshot(undefined);
    let funding: BuyerFunding | null;
    try {
      funding = (await window.desktopFunding?.balance(offerId)) ?? null;
      if (payer && funding?.payer !== payer) funding = null;
    } catch {
      funding = null;
    }
    if (generation.current !== id) return null;
    setSnapshot({ payer, offerId, attempt, funding });
    return funding;
  }, [payer, offerId, attempt]);
  useLayoutEffect(() => {
    if (enabled) void verify();
    return () => {
      generation.current++;
    };
  }, [enabled, verify]);
  const current =
    enabled &&
    snapshot &&
    snapshot.payer === payer &&
    snapshot.offerId === offerId &&
    snapshot.attempt === attempt;
  return {
    loading: !current,
    funding: current ? snapshot.funding : null,
    verify,
    refresh: () => setAttempt((n) => n + 1),
  };
}
