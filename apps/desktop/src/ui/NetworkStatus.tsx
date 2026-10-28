// Displays actual host-owned local-node state; it does not claim provider connectivity.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LOCAL_NODE,
  LOCAL_NODE_STATE,
  parseLocalNodeState,
  type LocalNodeState,
} from '../node-status';
import { LOCAL_NODE_LABELS } from './constants';

declare global {
  interface Window {
    desktopNode?: {
      summary(): Promise<LocalNodeState>;
      retry(): Promise<LocalNodeState>;
    };
  }
}
export function useLocalNode() {
  const [state, setState] = useState<LocalNodeState>(LOCAL_NODE_STATE.STARTING);
  const active = useRef(false);
  const sequence = useRef(0);
  const read = useCallback(async (retry = false) => {
    const current = ++sequence.current;
    let next: LocalNodeState = LOCAL_NODE_STATE.ERROR;
    try {
      next = parseLocalNodeState(
        await (retry
          ? window.desktopNode?.retry()
          : window.desktopNode?.summary()),
      );
    } catch {
      /* Host absence/failure is unavailable, never connected. */
    }
    if (active.current && current === sequence.current) setState(next);
  }, []);
  useEffect(() => {
    active.current = true;
    void read();
    const timer = window.setInterval(() => {
      void read();
    }, LOCAL_NODE.POLL_MS);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, [read]);
  return {
    state,
    retry: () => {
      void read(true);
    },
  };
}
export function NetworkStatus({
  state,
  onRetry,
}: {
  state: LocalNodeState;
  onRetry: () => void;
}) {
  const retry =
    state === LOCAL_NODE_STATE.ERROR || state === LOCAL_NODE_STATE.STOPPED;
  const label = LOCAL_NODE_LABELS[state];
  const detail =
    state === LOCAL_NODE_STATE.READY
      ? 'Local Iroh endpoint ready. Provider connectivity is not checked.'
      : retry
        ? 'Local node unavailable. Click to retry.'
        : 'Preparing or closing the local Iroh endpoint.';
  return (
    <button
      className="network-status"
      data-state={state}
      aria-label={`${label}. ${detail}`}
      title={detail}
      disabled={!retry}
      onClick={onRetry}
    >
      <span className="network-status-symbol" aria-hidden="true">
        <svg
          className="network-glyph"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path className="network-edge" d="M 5 6 L 12 17 L 19 6 Z" />
          <path
            className="network-flow"
            pathLength="100"
            d="M 5 6 L 12 17 L 19 6 Z"
          />
          <path
            className="network-flow network-flow--reverse"
            pathLength="100"
            d="M 5 6 L 12 17 L 19 6 Z"
          />
          <g className="network-nodes">
            <circle cx="5" cy="6" r="2.7" />
            <circle cx="19" cy="6" r="2.7" />
            <circle cx="12" cy="17" r="2.7" />
          </g>
        </svg>
        <span className="network-status-dot" />
      </span>
      <span className="network-status-copy">
        <span>Local node</span>
        <strong role="status" aria-live="polite">
          {label}
        </strong>
      </span>
    </button>
  );
}
