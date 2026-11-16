// Calls the fixed main-process bridge; no wallet credentials or network calls in the renderer.
import { useCallback, useEffect, useState } from 'react';

import {
  emptyX402,
  parseX402Result,
  X402_ACTION,
  type X402Progress,
  type X402Result,
} from '../x402-model';

declare global {
  interface Window {
    desktopX402?: {
      run(input: unknown): Promise<X402Result>;
      onProgress(listener: (value: X402Progress) => void): () => void;
    };
  }
}
export function useX402() {
  const [state, setState] = useState<X402Result>(() => ({
    summary: { ...emptyX402(), available: false, blocked: true },
    policy: null,
  }));
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (input: unknown, onDelta?: (text: string) => void) => {
      setBusy(true);
      let unsubscribe: (() => void) | undefined;
      let listening = true;
      try {
        if (!window.desktopX402) throw new Error('Buyer bridge unavailable');
        if (onDelta && input && typeof input === 'object' && 'id' in input) {
          const id = input.id;
          unsubscribe = window.desktopX402.onProgress((progress) => {
            if (listening && progress.id === id) onDelta(progress.text);
          });
        }
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
        listening = false;
        unsubscribe?.();
        setBusy(false);
      }
    },
    [],
  );
  const stop = useCallback(async (id: string) => {
    try {
      await window.desktopX402?.run({ action: X402_ACTION.STOP, id });
    } catch {
      // The original request retains its durable state and reports its own failure.
    }
  }, []);
  useEffect(() => {
    void run({ action: X402_ACTION.STATUS });
  }, [run]);
  return { state, busy, run, stop };
}
export type X402View = ReturnType<typeof useX402>;
