// Owned crash checkpoints for the offline payment acceptance; no product policy or timeouts.
export const CHANNEL_CRASH = {
  now: 1_800_000_000_000,
  funds: 100_000n,
  deposit: '1000',
  digest: 'ab'.repeat(32),
  timeoutMs: 20_000,
} as const;

export const CRASH_CUTS = {
  OPEN_BEFORE_CHECKPOINT: 'open-before-checkpoint',
  OPEN_CHECKPOINTED: 'open-checkpointed',
  OPEN_SIGNED: 'open-signed',
  OPEN_INFLIGHT: 'open-inflight',
  OPEN_INCLUDED: 'open-included',
  CLOSE_BEFORE_CHECKPOINT: 'close-before-checkpoint',
  CLOSE_CHECKPOINTED: 'close-checkpointed',
  CLOSE_INFLIGHT: 'close-inflight',
  CLOSE_INCLUDED: 'close-included',
  REFUND_BEFORE_CHECKPOINT: 'refund-before-checkpoint',
  REFUND_CHECKPOINTED: 'refund-checkpointed',
  REFUND_INFLIGHT: 'refund-inflight',
  REFUND_INCLUDED: 'refund-included',
} as const;
export type CrashCut = (typeof CRASH_CUTS)[keyof typeof CRASH_CUTS];

export const CRASH_ACTIONS = {
  OPEN: 'open',
  WITHDRAW: 'withdraw',
  OBSERVE: 'observe',
} as const;
export type CrashAction = (typeof CRASH_ACTIONS)[keyof typeof CRASH_ACTIONS];
