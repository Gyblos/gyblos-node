// Shares one renderer controller across Chat and Payments; never starts payment operations on navigation.
import { useEffect, useState, useSyncExternalStore } from 'react';

import { PAYPAL_SANDBOX_LIMIT_OPTIONS } from '@gyblos/config/constants';

import { DESKTOP_PAYPAL_AGENT } from '../paypal-agent-model';
import { PaypalChatController } from '../paypal-chat';
import {
  PAYPAL_DESKTOP_ERROR,
  paypalFailure,
  type PaypalRequest,
  type PaypalResult,
} from '../paypal-model';

declare global {
  interface Window {
    desktopPaypal?: {
      run(request: PaypalRequest): Promise<PaypalResult>;
      onReturn?(listener: () => void): () => void;
      onCancel?(listener: () => void): () => void;
    };
  }
}

export function usePaypalSession(monitor: boolean) {
  const [chat] = useState(
    () =>
      new PaypalChatController(async (request) =>
        window.desktopPaypal
          ? window.desktopPaypal.run(request)
          : paypalFailure(PAYPAL_DESKTOP_ERROR.UNAVAILABLE),
      ),
  );
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [limitCents, setLimitCents] = useState<number>(
    PAYPAL_SANDBOX_LIMIT_OPTIONS[0],
  );
  useEffect(() => {
    const removeReturn = window.desktopPaypal?.onReturn?.(() => {
      void chat.returnedFromPaypal();
    });
    const removeCancel = window.desktopPaypal?.onCancel?.(() => {
      void chat.cancelledFromPaypal();
    });
    return () => {
      removeReturn?.();
      removeCancel?.();
    };
  }, [chat]);
  useEffect(() => {
    if (!monitor) {
      chat.stopMonitoring();
      return;
    }
    chat.startMonitoring();
    void chat.refresh();
    const interval = window.setInterval(() => {
      void chat.poll();
    }, DESKTOP_PAYPAL_AGENT.POLL_MS);
    return () => {
      window.clearInterval(interval);
      chat.stopMonitoring();
    };
  }, [chat, monitor]);
  return { chat, state, limitCents, setLimitCents };
}

export type PaypalSessionView = ReturnType<typeof usePaypalSession>;
