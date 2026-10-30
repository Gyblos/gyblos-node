// Owns the payments-upto catalogs: which port call a failure happened in, the fields of a seller's
// own payment description, and the ledger file bounds and timing.
export const PAYMENT_PHASES = { ADMIT: 'admit', SETTLE: 'settle' } as const;
export type PaymentPhase = (typeof PAYMENT_PHASES)[keyof typeof PAYMENT_PHASES];

// Every PaymentDescription field; terms naming another value for any of them are not this seller's.
export const DESCRIPTION_FIELDS = [
  'network',
  'mint',
  'payTo',
  'feePayer',
  'authorizer',
  'protocolFeeBps',
  'treasury',
] as const;

export const LEDGER_FILE = {
  version: 1,
  // The whole ledger document; a seller's open and recent channels fit far below this.
  maxBytes: 8 * 1024 * 1024,
  // Finished channels are kept at least this long: far past any terms expiry, so a pruned channel's
  // authorization can no longer be admitted again.
  minRetentionMs: 86_400_000,
  // A new channel is refused once the document is this large, so the channels already open can
  // always still record their claims within maxBytes.
  // Half the bound: every open channel's remaining records (attempts, claim, pending) still fit.
  newChannelBytes: 4 * 1024 * 1024,
} as const;

// The seller's chain wiring: how long a sent open can still land (its blockhash lifetime, with margin),
// and how many channels the ledger keeps.
export const UPTO_SELLER = {
  openWindowMs: 90_000,
  // A ceiling on the record count; the byte bound (LEDGER_FILE.newChannelBytes) usually binds first.
  maxChannels: 10_000,
} as const;
