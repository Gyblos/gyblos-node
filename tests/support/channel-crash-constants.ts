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
  REFUND_SETTLED: 'refund-settled',
  REFUND_RESOLVED: 'refund-resolved',
  RECOVERY_LOCKED: 'recovery-locked',
} as const;
export type CrashCut = (typeof CRASH_CUTS)[keyof typeof CRASH_CUTS];

export const CRASH_ACTIONS = {
  OPEN: 'open',
  WITHDRAW: 'withdraw',
  OBSERVE: 'observe',
} as const;
export type CrashAction = (typeof CRASH_ACTIONS)[keyof typeof CRASH_ACTIONS];

export const CRASH_MESSAGES = {
  INIT: 'init',
  CALL: 'call',
  REPLY: 'reply',
  DONE: 'done',
} as const;
export const CRASH_CALLS = {
  SIGN: 'sign',
  ADMIT: 'admit',
  CUT: 'cut',
  ACCOUNT: 'getAccountInfo',
  EPOCH: 'getEpochInfo',
  SLOT: 'getSlot',
  TIME: 'getBlockTime',
  BLOCKHASH: 'getLatestBlockhash',
  GENESIS: 'getGenesisHash',
  SEND: 'sendTransaction',
  STATUSES: 'getSignatureStatuses',
  HISTORY: 'getSignaturesForAddress',
  TRANSACTION: 'getTransaction',
  OLDEST: 'oldestSlot',
} as const;
export type CrashCall = (typeof CRASH_CALLS)[keyof typeof CRASH_CALLS];
export const CRASH_FAILURE = 'CRASH_ACCEPTANCE_FAILED';
export const CRASH_LOCKS = {
  MALFORMED: 'malformed',
  FOREIGN: 'foreign',
  LIVE: 'live',
  GUARD: 'guard',
} as const;
