// Fixed evidence cases and bounds for the synthetic identity/free path; never operator inputs.
export const IDENTITY_ACCEPTANCE_CASES = {
  REGISTRY_ANSWER: 'registry-answer',
  REGISTRY_STREAM: 'registry-stream',
  REGISTRY_RENEWALS: 'registry-renewals',
  RPC_OUTAGE: 'rpc-outage',
  RPC_LIMIT: 'rpc-limit',
  REVOCATION_AT_SEND: 'revocation-at-send',
  MANUAL_OVERRIDE: 'manual-override',
  OVERRIDE_REMOVAL: 'override-removal',
  REVOCATION_RESTART: 'revocation-restart',
  ROTATION_DENIAL: 'rotation-denial',
  ROLLBACK_RESTART: 'rollback-restart',
  ROTATION_RECOVERY: 'rotation-recovery',
  STREAM_CANCELLATION: 'stream-cancellation',
  NO_POST_SEND_RETRY: 'no-post-send-retry',
  NO_QUERY_INFERENCE: 'no-query-inference',
  NO_PAID_SERVICES: 'no-paid-services',
} as const;
export type IdentityAcceptanceCase =
  (typeof IDENTITY_ACCEPTANCE_CASES)[keyof typeof IDENTITY_ACCEPTANCE_CASES];
export const IDENTITY_ACCEPTANCE = {
  registry: 'loopback-synthetic',
  initialSequence: 9007199254740993n,
  maxRunMs: 120000,
} as const;
