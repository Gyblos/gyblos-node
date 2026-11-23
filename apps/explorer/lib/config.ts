// Owns the public, read-only sources the explorer reads. No secrets: everything here is public on purpose.
export const DISCOVERY_URL =
  process.env.GYBLOS_DISCOVERY_URL ?? 'https://discovery.gyblos.com/v1';

// Public aggregates of signed receipts and observations (GET /v1/stats/*).
export const COLLECTOR_URL =
  process.env.GYBLOS_COLLECTOR_URL ?? 'https://collector.gyblos.com/v1';

// Networks the explorer can show; only a live one has data. Mainnet launches 2026-12-09.
export const TOKEN_LOGOS = {
  USDC: '/tokens/usdc.svg',
  SOLANA: '/tokens/solana.svg',
} as const;
export type Token = keyof typeof TOKEN_LOGOS;

export const NETWORKS = [
  {
    id: 'devnet',
    label: 'Solana devnet',
    live: true,
    icon: TOKEN_LOGOS.SOLANA,
  },
  {
    id: 'mainnet',
    label: 'Solana mainnet',
    live: false,
    icon: TOKEN_LOGOS.SOLANA,
  },
] as const;

const SOLANA_EXPLORER = 'https://explorer.solana.com';

export const explorerAddressUrl = (address: string) =>
  `${SOLANA_EXPLORER}/address/${address}?cluster=devnet`;

export const explorerTxUrl = (signature: string) =>
  `${SOLANA_EXPLORER}/tx/${signature}?cluster=devnet`;

export const PAYMENT_PROGRAM_SOURCE_URL =
  'https://github.com/solana-foundation/payment-channels/tree/0c07d5751c8972abf6a219570a3f39a72f46f879';

export const EXPLORER_DOCS = 'https://docs.gyblos.com/en/reference/explorer';
export const SITE_LINKS = {
  site: 'https://gyblos.tech',
  paper: 'https://gyblos.tech/paper',
  docs: 'https://docs.gyblos.com/en',
  github: 'https://github.com/Gyblos',
  x: 'https://x.com/gyblos',
} as const;
export const HELP_URL = {
  verified: `${EXPLORER_DOCS}#verified`,
  channelTransactions: `${EXPLORER_DOCS}#channel-transactions`,
  sellerTransactions: `${EXPLORER_DOCS}#seller-transactions`,
} as const;

export const gistUrl = (github: { account: string; gist: string }) =>
  `https://gist.github.com/${github.account}/${github.gist}`;
