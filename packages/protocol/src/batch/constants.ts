// Wire catalog for opt-in reusable sessions; existing inference ALPNs and vectors are unchanged.
export const BATCH_CHANNEL = {
  alpn: 'gyblos/session/4',
  version: 4,
  requestBytes: 1048576,
  responseBytes: 1048576,
  openingBytes: 524288,
  inputBytes: 65536,
  maxMessages: 1024,
  maxOutputTokens: 128,
  requestDomain: 'gyblos/session-request/v4\n',
  replyDomain: 'gyblos/session-rpc/v4\n',
} as const;
export const BATCH_METHODS = {
  PREPARE: 'prepare',
  OPEN: 'open',
  EXECUTE: 'execute',
  APPROVE: 'approve',
  SNAPSHOT: 'snapshot',
  CLOSE: 'close',
} as const;
export type BatchMethod = (typeof BATCH_METHODS)[keyof typeof BATCH_METHODS];

// Aggregate streaming output stays inside the former complete-response byte budget.
export const BATCH_STREAM = {
  deltaBytes: 8192,
  maxEvents: 4096,
  errorReserveBytes: 2048,
  events: { DELTA: 'delta', TERMINAL: 'terminal' },
} as const;
