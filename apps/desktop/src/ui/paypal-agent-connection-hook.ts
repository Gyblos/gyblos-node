// Tracks the local agent connection without trusting stale status responses.
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { PAYPAL_AGENT_POLL_TIMEOUT_MS } from '../constants';
import {
  agentFailure,
  createPaypalAgentStatusPoll,
  DESKTOP_PAYPAL_AGENT,
  PAYPAL_AGENT_ACTION,
  paypalAgentErrorMessage,
  paypalAgentStatusUnavailable,
  retainPaypalAgentStatus,
  type PaypalAgentAction,
  type PaypalAgentCopyTarget,
  type PaypalAgentResult,
} from '../paypal-agent-model';

declare global {
  interface Window {
    desktopPaypalAgent?: {
      run(request: { action: PaypalAgentAction }): Promise<PaypalAgentResult>;
      copy?(request: { target: PaypalAgentCopyTarget }): Promise<boolean>;
    };
  }
}

function actionFailure(
  action: PaypalAgentAction,
  error: PaypalAgentResult['error'],
) {
  return action === PAYPAL_AGENT_ACTION.DISCONNECT
    ? 'Could not confirm disconnection. The agent may still be connected; try again.'
    : paypalAgentErrorMessage(error);
}
type AgentStatusPolling = {
  busyRef: { current: boolean };
  sequence: { current: number };
  mounted: { current: boolean };
  pollerRef: { current: { isStalled(): boolean } | null };
  setResult: Dispatch<SetStateAction<PaypalAgentResult>>;
  setStatusUnavailable: Dispatch<SetStateAction<boolean>>;
};
function useAgentStatusPolling({
  busyRef,
  sequence,
  mounted,
  pollerRef,
  setResult,
  setStatusUnavailable,
}: AgentStatusPolling) {
  useEffect(() => {
    mounted.current = true;
    let statusSequence = 0;
    const poller = createPaypalAgentStatusPoll(
      async () => {
        const request = ++sequence.current;
        statusSequence = request;
        const next = await window.desktopPaypalAgent
          ?.run({ action: PAYPAL_AGENT_ACTION.STATUS })
          .catch(() => agentFailure());
        return { request, next };
      },
      ({ request, next }) => {
        if (mounted.current && request === sequence.current) {
          setResult(
            (previous) => retainPaypalAgentStatus(previous, next).result,
          );
          setStatusUnavailable(!next || !!next.error);
        }
      },
      () => {
        if (mounted.current && statusSequence === sequence.current)
          setStatusUnavailable(true);
      },
      PAYPAL_AGENT_POLL_TIMEOUT_MS,
    );
    pollerRef.current = poller;
    function refresh() {
      if (!busyRef.current) poller.poll();
    }
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, DESKTOP_PAYPAL_AGENT.POLL_MS);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      poller.stop();
      pollerRef.current = null;
      window.clearInterval(interval);
    };
  }, [busyRef, sequence, mounted, pollerRef, setResult, setStatusUnavailable]);
}
export function usePaypalAgentConnection() {
  const [result, setResult] = useState<PaypalAgentResult>({
    connection: null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [statusUnavailable, setStatusUnavailable] = useState(true);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pollerRef = useRef<{ isStalled(): boolean } | null>(null);
  const connection = result.connection;
  useAgentStatusPolling({
    busyRef,
    sequence,
    mounted,
    pollerRef,
    setResult,
    setStatusUnavailable,
  });
  async function run(action: PaypalAgentAction) {
    if (busyRef.current) return;
    busyRef.current = true;
    sequence.current += 1;
    setBusy(true);
    setNotice(
      action === PAYPAL_AGENT_ACTION.DISCONNECT
        ? 'Disconnecting. An inference already started can finish and count.'
        : '',
    );
    try {
      const next = await window.desktopPaypalAgent?.run({ action });
      if (!mounted.current) return;
      setResult((previous) => retainPaypalAgentStatus(previous, next).result);
      setStatusUnavailable(
        paypalAgentStatusUnavailable(
          action,
          next,
          !!pollerRef.current?.isStalled(),
        ),
      );
      if (!next || next.error)
        setNotice(actionFailure(action, next?.error ?? null));
      else setNotice('');
    } catch {
      if (mounted.current) {
        setStatusUnavailable(true);
        setNotice(
          'The local connection is unavailable; the agent may still be connected.',
        );
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function copy(target: PaypalAgentCopyTarget, label: string) {
    if (!connection) return;
    const copied = await window.desktopPaypalAgent
      ?.copy?.({ target })
      .catch(() => false);
    if (mounted.current)
      setNotice(
        copied
          ? `${label} copied.`
          : 'Could not copy. Check the connection and try again.',
      );
  }
  return { connection, busy, notice, statusUnavailable, run, copy };
}
