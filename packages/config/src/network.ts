// Devnet chain facts: genesis, program and mint addresses, RPC URL and Iroh relays.
export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export const CHANNEL_PROGRAM = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';

export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export const COMMITMENT = 'confirmed' as const;

export const FINALIZED_COMMITMENT = 'finalized' as const;

export const SVM_TRANSACTION_VERSION = 0 as const;

export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

export const IROH_RELAYS = {
  urls: ['https://na1.relay.gyblos.com/'],
  quicPort: 7842,
  // Exact hostnames that may receive GYBLOS_RELAY_TOKEN; no suffix matching.
  ownedHosts: ['na1.relay.gyblos.com', 'na2.relay.gyblos.com'],
} as const;

export const BUYER_RELAY_ONLY_ENV = 'GYBLOS_BUYER_RELAY_ONLY' as const;

export const DEVNET_TREASURY_OWNER =
  '4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap';

// The network's protocol fee, added on top of every seller's price and split on chain to the treasury
// in the same claim. Buyers and sellers both read it; changing the fee is changing bps here.
export const PROTOCOL_FEE = {
  bps: 300,
  treasury: DEVNET_TREASURY_OWNER,
} as const;

export { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';

export { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
