// Wire catalog for opt-in reusable sessions; existing inference ALPNs and vectors are unchanged.
export const BATCH_CHANNEL = {
  alpn: 'gyblos/session/1',
  version: 1,
  requestBytes: 1048576,
  responseBytes: 1048576,
  openingBytes: 524288,
  requestDomain: 'gyblos/session-request/v1\n',
  replyDomain: 'gyblos/session-rpc/v1\n',
} as const;
export const BATCH_METHODS = {
  OPEN: 'open',
  EXECUTE: 'execute',
  APPROVE: 'approve',
  SNAPSHOT: 'snapshot',
  CLOSE: 'close',
} as const;
export type BatchMethod = (typeof BATCH_METHODS)[keyof typeof BATCH_METHODS];
