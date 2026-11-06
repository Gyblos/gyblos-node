// Test-only unread-peer IPC values; startup preparation has its own bound, separate from measured egress.
export const READER_ACTIONS = {
  CONNECT: 'connect',
  REQUEST: 'request',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',
} as const;
export type ReaderAction = (typeof READER_ACTIONS)[keyof typeof READER_ACTIONS];
export const READER_STARTUP = {
  ready: 'reader-ready',
  milliseconds: 10000,
} as const;
