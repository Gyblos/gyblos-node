// Simulates the desktop network lifecycle; no relay, peer or internet check is performed.
// Connection availability is separate from the selected model and individual chat runs.
import { useEffect, useState } from 'react';

import {
  NETWORK_LABELS,
  NETWORK_STATE,
  PREVIEW_CONNECT_MS,
} from './constants.js';

export type NetworkState = (typeof NETWORK_STATE)[keyof typeof NETWORK_STATE];

export function usePreviewNetwork() {
  const [state, setState] = useState<NetworkState>(NETWORK_STATE.CONNECTING);
  useEffect(() => {
    if (state !== NETWORK_STATE.CONNECTING) return;
    const timer = window.setTimeout(
      () => setState(NETWORK_STATE.CONNECTED),
      PREVIEW_CONNECT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);
  return {
    state,
    online: state === NETWORK_STATE.CONNECTED,
    toggle: () =>
      setState((current) =>
        current === NETWORK_STATE.PAUSED
          ? NETWORK_STATE.CONNECTING
          : NETWORK_STATE.PAUSED,
      ),
  };
}

export function NetworkStatus({
  state,
  onToggle,
}: {
  state: NetworkState;
  onToggle: () => void;
}) {
  const action = state === NETWORK_STATE.PAUSED ? 'Resume' : 'Pause';
  const label = NETWORK_LABELS[state];
  return (
    <button
      className="network-status"
      data-state={state}
      aria-label={`Gyblos network: ${label}. ${action} connection`}
      title={`Gyblos network · ${label}. Click to ${action.toLowerCase()}.`}
      onClick={onToggle}
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
        <span>Network</span>
        <strong role="status" aria-live="polite">
          {label}
        </strong>
      </span>
    </button>
  );
}
