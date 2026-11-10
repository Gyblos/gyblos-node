// Operator defaults for capped client-signed batch sessions; thresholds never change a buyer's price.
export const BATCH_SESSION_DEFAULTS = {
  millisecondsPerSecond: 1000,
  withdrawDelaySeconds: 900,
  idleMs: 10 * 60 * 1000,
  minSettlementAtomic: '10000',
  pollMs: 15 * 1000,
  operationMs: 20 * 1000,
  maxPendingOperations: 32,
  saltBytes: 8,
  maxRequests: 128,
  stateBytes: 512 * 1024,
} as const;
