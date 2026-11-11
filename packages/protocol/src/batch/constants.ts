// Wire catalog for opt-in reusable sessions; existing inference ALPNs and vectors are unchanged.
export const BATCH_CHANNEL = {
  alpn: 'gyblos/session/3',
  version: 3,
  requestBytes: 1048576,
  responseBytes: 1048576,
  openingBytes: 524288,
  inputBytes: 65536,
  maxMessages: 1024,
  maxOutputTokens: 128,
  requestDomain: 'gyblos/session-request/v3\n',
  replyDomain: 'gyblos/session-rpc/v3\n',
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
