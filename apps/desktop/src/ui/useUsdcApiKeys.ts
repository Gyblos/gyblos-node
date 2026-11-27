// Refreshes owner-visible metadata; an explicit reveal reads one transient key without retaining it here.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  emptyUsdcApi,
  parseUsdcApiSecret,
  parseUsdcApiState,
  USDC_API,
  USDC_API_ACTION,
  type UsdcApiSecret,
  type UsdcApiState,
} from '../usdc-api-model';

declare global {
  interface Window {
    desktopUsdcApiKeys?: {
      run(input: unknown): Promise<UsdcApiState>;
      reveal?(input: unknown): Promise<UsdcApiSecret>;
    };
  }
}
export async function keyReviewStatus(policyId: string | undefined) {
  try {
    const state = parseUsdcApiState(
      await window.desktopUsdcApiKeys?.run({ action: USDC_API_ACTION.STATUS }),
    );
    if (
      policyId &&
      state.policyId === policyId &&
      state.snapshot &&
      !state.error
    )
      return state.snapshot.blocked
        ? 'The API key ledger still requires review.'
        : 'The API key ledger currently allows new requests.';
  } catch {
    return 'Could not confirm the API key ledger status.';
  }
  return 'Could not confirm the API key ledger status.';
}

function useKeyReveal(
  running: { current: boolean },
  mounted: { current: boolean },
  policyId: { current: string | null },
  setBusy: (value: boolean) => void,
) {
  return useCallback(
    async (id: string) => {
      const policy = policyId.current;
      if (
        !mounted.current ||
        running.current ||
        !policy ||
        !window.desktopUsdcApiKeys?.reveal
      )
        throw new Error('API key is unavailable');
      running.current = true;
      setBusy(true);
      try {
        const result = parseUsdcApiSecret(
          await window.desktopUsdcApiKeys.reveal({ id, policyId: policy }),
        );
        if (
          !mounted.current ||
          policyId.current !== policy ||
          result.policyId !== policy ||
          result.id !== id
        )
          throw new Error('API key is unavailable');
        return result.secret;
      } finally {
        running.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [running, mounted, policyId, setBusy],
  );
}
export function useUsdcApiKeys() {
  const [state, setState] = useState(emptyUsdcApi);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(false);
  const policyId = useRef<string | null>(null);
  const run = useCallback(async (input: unknown) => {
    if (running.current) return null;
    running.current = true;
    if (mounted.current) setBusy(true);
    try {
      if (!window.desktopUsdcApiKeys)
        throw new Error('Buyer bridge unavailable');
      const request =
        input &&
        typeof input === 'object' &&
        'action' in input &&
        input.action !== USDC_API_ACTION.STATUS
          ? { ...input, policyId: policyId.current }
          : input;
      const result = parseUsdcApiState(
        await window.desktopUsdcApiKeys.run(request),
      );
      policyId.current = result.policyId;
      if (mounted.current) setState(result);
      return result;
    } catch {
      if (mounted.current)
        setState((old) => ({
          ...old,
          error: 'Could not confirm key status. Refresh before using the API.',
        }));
      return null;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void run({ action: USDC_API_ACTION.STATUS });
    const interval = window.setInterval(() => {
      void run({ action: USDC_API_ACTION.STATUS });
    }, USDC_API.POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [run]);
  const reveal = useKeyReveal(running, mounted, policyId, setBusy);
  return { state, busy, run, reveal };
}
