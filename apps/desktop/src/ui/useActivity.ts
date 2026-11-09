// Reads local metadata without initializing or authorizing payment services.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  parseActivityResult,
  unavailableActivity,
  type ActivityResult,
} from '../activity-model';
import { DESKTOP_ACTIVITY } from '../constants';
import {
  parsePaymentReferences,
  unavailablePaymentReferences,
  type PaymentReferenceResult,
} from '../payment-reference-model';

declare global {
  interface Window {
    desktopActivity?: {
      summary(): Promise<ActivityResult>;
      references?(): Promise<PaymentReferenceResult>;
    };
  }
}
export function useActivity() {
  const [state, setState] = useState<ActivityResult | null>(null);
  const [references, setReferences] = useState(unavailablePaymentReferences);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const result = await Promise.resolve()
      .then(() => window.desktopActivity?.summary())
      .then((value) => parseActivityResult(value))
      .catch(unavailableActivity);
    const nextReferences = await Promise.resolve()
      .then(() => window.desktopActivity?.references?.())
      .then(parsePaymentReferences)
      .catch(unavailablePaymentReferences);
    if (mounted.current && sequence.current === request) {
      setState(result);
      setReferences(nextReferences);
    }
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
  return { state, references, refresh };
}
export type ActivityView = ReturnType<typeof useActivity>;
