// Operator defaults for capped client-signed batch sessions; thresholds never change a buyer's price.
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
  // Soft checkpoint target measured with the pinned tokenizer; an indivisible prefix can be larger.
  blockTargetTokens: 64,
  stateBytes: 512 * 1024,
  minDepositAtomic: '10000',
  maxDepositAtomic: '1000000',
  minLifetimeMs: 5 * 60 * 1000,
  maxLifetimeMs: 24 * 60 * 60 * 1000,
  maxWithdrawDelaySeconds: 3600,
} as const;

export const BUYER_DEPOSIT_MINIMUM_HINT = `Set session.depositAtomic to at least ${BATCH_SESSION_DEFAULTS.minDepositAtomic} (0.01 USDC) to open a payment channel.`;

// Written by guided buyer setup. The separate request ceiling still controls spending.
export const BUYER_SESSION_DEFAULT_POLICY = {
  depositAtomic: BATCH_SESSION_DEFAULTS.maxDepositAtomic,
  lifetimeMs: 3_600_000,
} as const;
