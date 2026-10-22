// Owns constants in transport-iroh; it must not know wallets or inference engines.
export const TRANSPORT_ROUTES = {
  LOOPBACK: 'loopback',
  DIRECT: 'iroh-direct',
  RELAY: 'iroh-relay',
  UNKNOWN: 'unknown',
} as const;

export const ROUTE_DISCREPANCY = 'route-discrepancy' as const;

export const RELAY_CONFIGURATION_CODES = {
  INVALID_URLS: 'INVALID_RELAY_URLS',
  MISSING_TOKEN: 'MISSING_RELAY_TOKEN',
  INVALID_TOKEN: 'INVALID_RELAY_TOKEN',
  UNCONFIGURED: 'UNCONFIGURED_RELAY',
  INVALID_TOKEN_LENGTH: 'INVALID_RELAY_TOKEN_LENGTH',
  MAP_FAILED: 'RELAY_MAP_FAILED',
  RELAY_REQUIRED: 'OFFER_RELAY_REQUIRED',
} as const;

export const RELAY_TOKEN_LENGTH = { min: 32, max: 512 } as const;

export type RelayConfigurationCode =
  (typeof RELAY_CONFIGURATION_CODES)[keyof typeof RELAY_CONFIGURATION_CODES];
