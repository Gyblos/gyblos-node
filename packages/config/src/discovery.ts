// Operator value: the default HTTP discovery index base URL (the apps/discovery-index Worker).
// The index is an untrusted cache; verification policy belongs to the discovery adapter and core.
export const DISCOVERY_INDEX_URL = 'https://discovery.gyblos.com/v1';

// Explicit opt-in: starting a node alone does not publish to a public index.
export const SELLER_DISCOVERY = {
  enabledEnvironment: 'GYBLOS_DISCOVERY_PUBLISH',
  urlEnvironment: 'GYBLOS_DISCOVERY_URL',
  tickMs: 10_000,
  requestMs: 5_000,
  retryMs: 10_000,
  maxRetryMs: 60_000,
} as const;
