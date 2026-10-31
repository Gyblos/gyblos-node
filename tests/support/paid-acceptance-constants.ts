// Owns the simulated paid-startup acceptance vocabulary and bounded verification limits.
export const PAID_ACCEPTANCE = {
  runMs: 90000,
  outputBytes: 32768,
  killMs: 1000,
  maxAtomic: '1000',
  maxTokens: 64,
  inputTokens: 4,
  text: 'synthetic paid answer',
  worker: './paid-acceptance-worker.ts',
} as const;
export const PAID_ACCEPTANCE_CASES = {
  STARTUP: 'product-startup',
  PRESEND: 'pre-send-discard-without-generation',
  COMPLETE: 'complete-answer',
  STREAM: 'streamed-answer',
  RESTART: 'role-restart',
  SHARES: 'independent-ledger-refuses-wrong-shares',
  PENDING: 'unverified-settlement-blocks',
  PERSISTED: 'uncertainty-survives-restart',
  CONFIRMED: 'explicit-simulated-confirmation',
  RECOVERY: 'seller-recovers-pending-claim-once',
  ENGINE: 'engine-failure-no-retry',
  CANCEL: 'cancellation-no-retry',
  PRIVACY: 'private-content-free-records',
  ISOLATION: 'no-external-services',
} as const;
export interface PaidAcceptanceReport {
  ok: true;
  nativeIroh: true;
  simulatedChain: true;
  realPayments: false;
  cases: (typeof PAID_ACCEPTANCE_CASES)[keyof typeof PAID_ACCEPTANCE_CASES][];
  answers: number;
  attempts: number;
  deposits: number;
  settlements: number;
  restarts: number;
  blocked: number;
  externalCalls: number;
  registryReads: number;
  forbiddenRpcMethods: number;
}
