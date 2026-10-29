// Synthetic startup acceptance values; never accepts a home, endpoint, provider or payment override.
import type { ACCEPTANCE_INDEX } from './constants';

export const RECEIPT_ACCEPTANCE = {
  maxRunMs: 60000,
  pollMs: 20,
  settleMs: 4000,
  reportBytes: 16384,
  stderrBytes: 8192,
  killMs: 1000,
  unsafeFileMode: 0o644,
  configFile: 'receipt-acceptance.toml',
  engineOrigin: 'https://receipt-engine.invalid',
  text: 'synthetic output marker',
  worker: 'receipt-worker.ts',
  modelId: 'synthetic-receipt-model',
  contextTokens: 4096,
  maxTokens: 8,
  dailyCap: 100000,
  buyerCap: 10000,
} as const;
export const RECEIPT_ACCEPTANCE_CASES = {
  STARTUP: 'startup-configured',
  DISCOVERY: 'published-discovered',
  COMPLETE: 'complete-confirmed',
  STREAM: 'stream-confirmed',
  RESTART: 'restart-persistence-sequences',
  RECEIPT_FAILURE: 'receipt-failure-no-retry',
  CANCEL: 'stream-cancellation-no-retry',
  ENGINE_FAILURE: 'engine-failure-no-retry',
  FREE_CAPS: 'configured-free-cap',
  PRIVACY: 'private-bounded-metadata',
  NO_EXTERNAL: 'no-external-io-or-payments',
} as const;
export type ReceiptAcceptanceCase =
  (typeof RECEIPT_ACCEPTANCE_CASES)[keyof typeof RECEIPT_ACCEPTANCE_CASES];
export interface ReceiptAcceptanceReport {
  ok: true;
  nativeIroh: true;
  paymentsEnabled: false;
  index: typeof ACCEPTANCE_INDEX;
  cases: ReceiptAcceptanceCase[];
  answers: number;
  engineAttempts: number;
  confirmed: number;
  externalCalls: number;
  discoveryReads: number;
}
