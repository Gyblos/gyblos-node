// Transport route names, relay configuration error codes and relay token length bounds.
export const TRANSPORT_ROUTES = {
  LOOPBACK: 'loopback',
  DIRECT: 'iroh-direct',
  RELAY: 'iroh-relay',
  UNKNOWN: 'unknown',
} as const;

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
