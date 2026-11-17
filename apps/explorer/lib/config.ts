// Owns the public, read-only sources the explorer reads. No secrets: everything here is public on purpose.
export const DISCOVERY_URL =
  process.env.GYBLOS_DISCOVERY_URL ?? 'https://discovery.gyblos.com/v1';

// Public aggregates of signed receipts and observations (GET /v1/stats/*).
export const COLLECTOR_URL =
  process.env.GYBLOS_COLLECTOR_URL ?? 'https://collector.gyblos.com/v1';

export const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

export const NETWORK_LABEL = 'Solana devnet';

// x402 payment-channels program (shared with other users of the program).
export const CHANNEL_PROGRAM = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';

// Gyblos devnet fee treasury (public test wallet). Settlements that pay a Gyblos fee
// touch one of its token accounts; that is how Gyblos traffic is told apart.
export const GYBLOS_TREASURY = '4Ui1dfvqbFx9CtjXNcKajHdr7aKT1nbYRiYjB1s7umNy';

// The payment program's own treasury: receives rounding residual, never Gyblos revenue.
export const PROGRAM_TREASURY = '4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const explorerTxUrl = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
export const explorerAddressUrl = (address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;
