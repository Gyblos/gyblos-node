// Owns the standalone local collector's static route, limits and errors; no state starts on import.
export const LOCAL_COLLECTOR_CODES = {
  INVALID: 'COLLECTOR_INVALID',
  UNAUTHORIZED: 'COLLECTOR_UNAUTHORIZED',
  FORBIDDEN: 'COLLECTOR_FORBIDDEN',
  BUSY: 'COLLECTOR_BUSY',
  LIMIT: 'COLLECTOR_LIMIT',
  TIMEOUT: 'COLLECTOR_TIMEOUT',
  STORAGE: 'COLLECTOR_STORAGE',
  CLOSED: 'COLLECTOR_CLOSED',
} as const;
export type LocalCollectorCode =
  (typeof LOCAL_COLLECTOR_CODES)[keyof typeof LOCAL_COLLECTOR_CODES];
export const LOCAL_COLLECTOR = {
  route: '/v1/receipts',
  active: 4,
  connections: 16,
  principals: 32,
  requestMs: 5000,
  closeMs: 5000,
  sweepMs: 1000,
  perMinute: 10,
  globalPerMinute: 120,
  windowMs: 60000,
  tokenBytes: 32,
  configBytes: 16384,
  headerBytes: 4096,
  maxPort: 65535,
  version: 1,
} as const;
