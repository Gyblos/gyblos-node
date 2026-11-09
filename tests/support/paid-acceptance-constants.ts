// Owns the simulated paid-startup acceptance vocabulary and bounded verification limits.
export const PAID_ACCEPTANCE = {
  runMs: 90000,
  outputBytes: 32768,
  killMs: 1000,
  maxAtomic: '10000',
  maxTokens: 64,
  inputTokens: 5,
  text: 'synthetic paid answer',
  interruptedText: 'synthetic fragment!',
  worker: './paid-acceptance-worker.ts',
} as const;
export const PAID_ACCEPTANCE_CASES = {
  STARTUP: 'product-startup',
  FREE: 'automatic-free-without-payment-preparation',
  FREE_CLI: 'automatic-free-terminal-with-paid-budget',
  FREE_CANCEL: 'automatic-free-cancellation-no-retry',
  FREE_RECEIPTS: 'automatic-free-confirmed-receipts',
  FREE_PENDING: 'uncertain-payment-blocks-free-after-restart',
  TELEMETRY: 'automatic-free-private-telemetry',
  PRESEND: 'pre-send-discard-without-generation',
  CLI_ANSWER: 'terminal-chat-answer',
  CLI_INTERRUPTED: 'terminal-chat-interrupted-settlement',
  CLI_RECONCILED: 'terminal-chat-interrupted-reconciled',
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
  freeAnswers: number;
  freeAttempts: number;
  freePaymentPreparations: number;
  freeTokenizerLoads: number;
  confirmedReceipts: number;
  telemetryEvents: number;
}
