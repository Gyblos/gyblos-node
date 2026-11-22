// Owns the public, read-only sources the explorer reads. No secrets: everything here is public on purpose.
export const DISCOVERY_URL =
  process.env.GYBLOS_DISCOVERY_URL ?? 'https://discovery.gyblos.com/v1';

// Public aggregates of signed receipts and observations (GET /v1/stats/*).
export const COLLECTOR_URL =
  process.env.GYBLOS_COLLECTOR_URL ?? 'https://collector.gyblos.com/v1';

// Networks the explorer can show; only a live one has data. Mainnet launches 2026-12-09.
export const NETWORKS = [
  { id: 'devnet', label: 'Solana devnet', live: true },
  { id: 'mainnet', label: 'Solana mainnet', live: false },
] as const;

export const explorerAddressUrl = (address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;

export const explorerTxUrl = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

export const PAYMENT_PROGRAM_SOURCE_URL =
  'https://github.com/solana-foundation/payment-channels';
