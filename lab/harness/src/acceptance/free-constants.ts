// Fixed synthetic-only free acceptance cases and fault names; never accepts operator paths or origins.
export const FREE_ACCEPTANCE_CASES = {
  DISCOVERY_ANSWER: 'discovery-answer',
  RENEWAL_ANSWERS: 'renewal-answers',
  BUSY_RECOVERY: 'busy-recovery',
  ENGINE_RECOVERY: 'engine-recovery',
  EXPIRY_RECOVERY: 'expiry-recovery',
  RESTART_REPLAY: 'restart-replay',
  EXECUTION_REPLAY: 'execution-replay',
  EXPIRED_QUOTE: 'expired-quote',
  WRONG_PEER: 'wrong-peer',
  ENGINE_DOWN: 'engine-down',
  FREE_CAPS: 'free-caps',
  PRE_SEND_FAILOVER: 'pre-send-failover',
  NO_POST_SEND_FAILOVER: 'no-post-send-failover',
  NO_QUERY_INFERENCE: 'no-query-inference',
  NO_PAID_SERVICES: 'no-paid-services',
} as const;
export type FreeAcceptanceCase =
  (typeof FREE_ACCEPTANCE_CASES)[keyof typeof FREE_ACCEPTANCE_CASES];
export const FREE_ACCEPTANCE_FAULTS = {
  DIAL: 'dial',
  RESPONSE: 'response',
} as const;
export type FreeAcceptanceFault =
  (typeof FREE_ACCEPTANCE_FAULTS)[keyof typeof FREE_ACCEPTANCE_FAULTS];
export const FREE_ACCEPTANCE = {
  maxRunMs: 60000,
  maxTokens: 2,
  httpResponseBytes: 65536,
  dailyTokenCap: 1000,
  perBuyerCap: 100,
  limitedDailyCap: 5,
  limitedBuyerCap: 3,
  maxOutputTokens: 4096,
} as const;

export const FREE_STREAM_ACCEPTANCE = {
  cancelPollMs: 10,
  cancelPollAttempts: 100,
} as const;
