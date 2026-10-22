// Owns network in config; it must not know product workflows or lab orchestration.
export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export const CHANNEL_PROGRAM = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';

export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const UPSTREAM_COMMIT = 'faa1c694c66a3732aaabbce93bdae140e521a67d';

export const COMMITMENT = 'confirmed' as const;

export const FINALIZED_COMMITMENT = 'finalized' as const;

export const SVM_TRANSACTION_VERSION = 0 as const;

export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

export const IROH_RELAYS = {
  urls: ['https://na1.relay.gyblos.com/'],
  quicPort: 7842,
  ownedHostSuffix: '.relay.gyblos.com',
} as const;

export const BUYER_RELAY_ONLY_ENV = 'GYBLOS_BUYER_RELAY_ONLY' as const;

export const PUBLIC_FACILITATORS = [
  {
    url: 'https://x402.org/facilitator',
    feePayer: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5',
  },
  {
    url: 'https://facilitator.payai.network',
    feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
  },
] as const;

export const DEVNET_TREASURY_OWNER =
  '4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap';

export { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';

export { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
