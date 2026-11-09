// Calls the fixed main-process bridge; no wallet credentials or network calls in the renderer.
import { useCallback, useEffect, useState } from 'react';

import {
  emptyX402,
  parseX402Result,
  X402_ACTION,
  type X402Result,
} from '../x402-model';

declare global {
  interface Window {
    desktopX402?: { run(input: unknown): Promise<X402Result> };
  }
}
export function useX402() {
  const [state, setState] = useState<X402Result>(() => ({
    summary: { ...emptyX402(), available: false, blocked: true },
    policy: null,
  }));
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (input: unknown) => {
    setBusy(true);
    try {
      if (!window.desktopX402) throw new Error('Buyer bridge unavailable');
      const result = parseX402Result(await window.desktopX402.run(input));
      setState(result);
      return result;
    } catch {
      const error =
        'Local buyer or spending records are unavailable. No further requests can be sent.';
      setState((previous) => ({
        ...previous,
        error,
        summary: { ...previous.summary, available: false, blocked: true },
      }));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void run({ action: X402_ACTION.STATUS });
  }, [run]);
  return { state, busy, run };
}
export type X402View = ReturnType<typeof useX402>;
