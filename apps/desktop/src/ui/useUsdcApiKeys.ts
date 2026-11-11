// Refreshes owner-visible key metadata; credentials and buyer requests stay in the main process.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  emptyUsdcApi,
  parseUsdcApiState,
  USDC_API,
  USDC_API_ACTION,
  type UsdcApiState,
} from '../usdc-api-model';

declare global {
  interface Window {
    desktopUsdcApiKeys?: { run(input: unknown): Promise<UsdcApiState> };
  }
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
  return { state, busy, run };
}
