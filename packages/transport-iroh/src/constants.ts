// Transport route names, relay configuration error codes, relay token length bounds, HTTP-over-Iroh
// framing limits and internal stream deadlines. Operator-tunable capacity lives in @gyblos/config.

// Wire-visible framing limits; tests pin these values.
export const HTTP_OVER_IROH = {
  bodyBytes: 64 * 1024,
  headerBytes: 24 * 1024,
  responseBytes: 256 * 1024,
  maxHeaders: 32,
  headerTerminatorBytes: 4,
  maxHttpStatus: 599,
  streamCloseCode: 1n,
} as const;

export const IROH_DEADLINES = {
  ingressMs: 5_000,
  egressMs: 5_000,
  connectionIdleMs: 30_000,
  connectionLifetimeMs: 15 * 60_000,
  routePollMs: 100,
} as const;

export const TRANSPORT_ROUTES = {
  LOOPBACK: 'loopback',
  DIRECT: 'iroh-direct',
  RELAY: 'iroh-relay',
  UNKNOWN: 'unknown',
} as const;

// Per-peer connection caps apply per family: a buyer may hold one control (quote) and one data
// (execution) connection at once, because the seller can still hold a just-closed control connection.
export const CONNECTION_FAMILIES = {
  CONTROL: 'control',
  DATA: 'data',
  RECEIPT: 'receipt',
} as const;
export type ConnectionFamily =
  (typeof CONNECTION_FAMILIES)[keyof typeof CONNECTION_FAMILIES];

export const ROUTE_DISCREPANCY = 'route-discrepancy' as const;

export const RELAY_CONFIGURATION_CODES = {
  INVALID_URLS: 'INVALID_RELAY_URLS',
  UNCONFIGURED: 'UNCONFIGURED_RELAY',
  REQUIRED: 'RELAY_REQUIRED',
  MAP_FAILED: 'RELAY_MAP_FAILED',
  MISSING_TOKEN: 'MISSING_RELAY_TOKEN',
  INVALID_TOKEN: 'INVALID_RELAY_TOKEN',
  INVALID_TOKEN_LENGTH: 'INVALID_RELAY_TOKEN_LENGTH',
  DIRECT_CANDIDATE: 'RELAY_ONLY_DIRECT_CANDIDATE',
} as const;

export const RELAY_TOKEN_LENGTH = { min: 32, max: 512 } as const;

export type RelayConfigurationCode =
  (typeof RELAY_CONFIGURATION_CODES)[keyof typeof RELAY_CONFIGURATION_CODES];
