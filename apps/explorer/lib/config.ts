// Owns the public, read-only sources the explorer reads. No secrets: everything here is public on purpose.
export const DISCOVERY_URL =
  process.env.GYBLOS_DISCOVERY_URL ?? 'https://discovery.gyblos.com/v1';

// Public aggregates of signed receipts and observations (GET /v1/stats/*).
export const COLLECTOR_URL =
  process.env.GYBLOS_COLLECTOR_URL ?? 'https://collector.gyblos.com/v1';

export const TOKEN_LOGOS = {
  USDC: '/tokens/usdc.svg',
  SOLANA: '/tokens/solana.svg',
} as const;
export type Token = keyof typeof TOKEN_LOGOS;

// Networks the explorer can show; only a live one has data. Mainnet launches 2026-12-09.

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

export const SITE_LINKS = {
  site: 'https://gyblos.tech',
  paper: 'https://gyblos.tech/paper',
  docs: 'https://docs.gyblos.com/en',
  github: 'https://github.com/Gyblos',
  x: 'https://x.com/gyblos',
} as const;
export const HELP_TEXT = {
  verified:
    "A ✓ means the discovery index found the seller's NodeId in a gist of that GitHub account. It links the seller to the account; it does not identify a person or rate quality. A name in smaller type is chosen by the seller and is not verified.",
  channelTransactions:
    'Each row is one change to a Gyblos payment channel on Solana. Amount is what the buyer deposited, what was newly settled, what the seller side received (Paid out, in green) or what went back to the buyer. A payout also fills Gyblos fee, Program and To buyer. Do not add rows up: the same USDC can appear more than once.',
  sellerTransactions:
    'Channels whose payout recipient is the owner address this seller declared. The seller chooses that address, so it is not verified. Amounts read as in Channel transactions.',
} as const;

export const gistUrl = (github: { account: string; gist: string }) =>
  `https://gist.github.com/${github.account}/${github.gist}`;
