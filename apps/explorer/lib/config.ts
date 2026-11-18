// Owns the public, read-only sources the explorer reads. No secrets: everything here is public on purpose.
export const DISCOVERY_URL =
  process.env.GYBLOS_DISCOVERY_URL ?? 'https://discovery.gyblos.com/v1';

// Public aggregates of signed receipts and observations (GET /v1/stats/*).
export const COLLECTOR_URL =
  process.env.GYBLOS_COLLECTOR_URL ?? 'https://collector.gyblos.com/v1';

export const NETWORK_LABEL = 'Solana devnet';

export const explorerAddressUrl = (address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;
