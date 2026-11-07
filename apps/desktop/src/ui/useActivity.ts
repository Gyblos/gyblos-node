// Reads local metadata without initializing or authorizing payment services.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  parseActivityResult,
  unavailableActivity,
  type ActivityResult,
} from '../activity-model';
import { DESKTOP_ACTIVITY } from '../constants';

declare global {
  interface Window {
    desktopActivity?: { summary(): Promise<ActivityResult> };
  }
}
export function useActivity() {
  const [state, setState] = useState<ActivityResult | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const result = await Promise.resolve()
      .then(() => window.desktopActivity?.summary())
      .then((value) => parseActivityResult(value))
      .catch(unavailableActivity);
    if (mounted.current && sequence.current === request) setState(result);
    return result;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, DESKTOP_ACTIVITY.POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);
  return { state, refresh };
}
export type ActivityView = ReturnType<typeof useActivity>;
