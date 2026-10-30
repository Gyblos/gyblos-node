// Owns the payments-upto ledger file bounds and timing.
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
