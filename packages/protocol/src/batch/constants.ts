// Wire catalog for opt-in reusable sessions; existing inference ALPNs and vectors are unchanged.
export const BATCH_CHANNEL = {
  alpn: 'gyblos/session/2',
  version: 2,
  requestBytes: 1048576,
  responseBytes: 1048576,
  openingBytes: 524288,
  inputBytes: 65536,
  maxMessages: 1024,
  maxOutputTokens: 128,
  requestDomain: 'gyblos/session-request/v2\n',
  replyDomain: 'gyblos/session-rpc/v2\n',
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
