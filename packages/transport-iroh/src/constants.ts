// Owns constants in transport-iroh; it must not know wallets or inference engines.
export const TRANSPORT_ROUTES = {
  LOOPBACK: 'loopback',
  DIRECT: 'iroh-direct',
  RELAY: 'iroh-relay',
  UNKNOWN: 'unknown',
} as const;

export const ROUTE_DISCREPANCY = 'route-discrepancy' as const;
