// Operator defaults for capped client-signed batch sessions; thresholds never change a buyer's price.
export const SELLER_SESSION_BUYER_ENV = 'GYBLOS_SESSION_BUYER_NODE_ID';
export const BATCH_SESSION_DEFAULTS = {
  millisecondsPerSecond: 1000,
  withdrawDelaySeconds: 900,
  idleMs: 10 * 60 * 1000,
  minSettlementAtomic: '10000',
  pollMs: 15 * 1000,
  operationMs: 20 * 1000,
  maxPendingOperations: 32,
  maxSessions: 16,
  poolBytes: 128 * 1024,
  saltBytes: 8,
  maxRequests: 128,
  stateBytes: 512 * 1024,
  maxDepositAtomic: '1000000',
  minLifetimeMs: 5 * 60 * 1000,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  maxWithdrawDelaySeconds: 3600,
} as const;
