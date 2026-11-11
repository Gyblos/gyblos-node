// Owns the bounded synthetic multi-seller acceptance vocabulary; no production settings or private data.
export const HTTP_MULTI = {
  operationMs: 10000,
  runMs: 60000,
  maxBytes: 262144,
  maxPending: 32,
  killMs: 1000,
  depositAtomic: '100000',
  totalAtomic: '200000',
  queueWaitMs: 1000,
} as const;
export const HTTP_MULTI_CASES = {
  PARALLEL: 'parallel-restart-settlement',
  WAIT: 'wait-expiry-cancellation-renewal',
  SENT: 'uncertainty-with-sent-peer',
  UNSENT: 'uncertainty-with-unsent-peer',
} as const;
export type HttpMultiCase = (typeof HTTP_MULTI_CASES)[keyof typeof HTTP_MULTI_CASES];
export const HTTP_MULTI_METHODS = {
  HELLO: 'hello', INIT: 'init', START: 'start', STOP: 'stop', SIGN: 'sign',
  HEALTH: 'health', HOLD: 'hold', RELEASE: 'release', ACK: 'ack',
  VERIFY: 'verify', SETTLE: 'settle', OBSERVE: 'observe', OPENED: 'opened',
} as const;
export type HttpMultiMethod = (typeof HTTP_MULTI_METHODS)[keyof typeof HTTP_MULTI_METHODS];
export interface HttpMultiReport {
  nativeIroh: true;
  answers: number;
  generations: number;
  deposits: number;
  externalCalls: number;
  registryReads: number;
  forbiddenRpcMethods: number;
}
