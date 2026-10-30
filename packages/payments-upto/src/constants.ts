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
  // A lock older than this was left by a crashed writer (one write takes milliseconds).
  staleLockMs: 10_000,
  // How long a writer waits for another process's lock before reporting the ledger unavailable.
  lockWaitMs: 1_000,
  lockRetryMs: 25,
} as const;
