export const MAX_ATOMIC = '10000';
export const ACTUAL_ATOMIC = '4000';
export const MIN_FACILITATOR_LAMPORTS = 15_000_000n;
export const FIXED_MIN_FACILITATOR_LAMPORTS = 10_000_000n;
export const TIMEOUTS = {
  rpc: 20_000,
  buyer: 120_000,
  inference: 180_000,
  startupPoll: 250,
  stop: 2000,
} as const;
export const RETRIES = {
  confirmation: 30,
  rpc: 4,
  transaction: 4,
  startup: 120,
} as const;
export const HTTP_STATUS = {
  ok: 200,
  paymentRequired: 402,
  conflict: 409,
  badGateway: 502,
} as const;
