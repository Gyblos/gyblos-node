// Canonical acceptance modes, evidence cases and static failures; no operational state or secrets.
import { CONTROL_CAPACITY } from '@gyblos/core/constants';

export const ACCEPTANCE_MODES = {
  SYNTHETIC: 'synthetic',
  OLLAMA: 'ollama',
} as const;
export type AcceptanceMode =
  (typeof ACCEPTANCE_MODES)[keyof typeof ACCEPTANCE_MODES];
export const ACCEPTANCE_CLOCKS = {
  ACCELERATED: 'accelerated',
  WALL: 'wall',
} as const;
export const ACCEPTANCE_INDEX = 'in-process-memory';
export const ACCEPTANCE_CASES = {
  DISCOVERY_QUOTE: 'discovery-quote',
  RENEWAL_CYCLES: 'renewal-cycles',
  BUSY_RECOVERY: 'busy-recovery',
  CHECK_FAILURE_RECOVERY: 'check-failure-recovery',
  EXPIRY_RECOVERY: 'expiry-recovery',
  WITHDRAWAL_REPLAY: 'withdrawal-replay',
  RESTART_SEQUENCE: 'restart-sequence',
  NO_QUERY_INFERENCE: 'no-query-inference',
} as const;
export type AcceptanceCase =
  (typeof ACCEPTANCE_CASES)[keyof typeof ACCEPTANCE_CASES];
export const ACCEPTANCE_CODES = {
  INVALID_OPTIONS: 'ACCEPTANCE_INVALID_OPTIONS',
  EXTERNAL_IO: 'ACCEPTANCE_EXTERNAL_IO',
  CANCELLED: 'ACCEPTANCE_CANCELLED',
  FAILED: 'ACCEPTANCE_FAILED',
  ENGINE_UNAVAILABLE: 'ACCEPTANCE_ENGINE_UNAVAILABLE',
  NATIVE_UNAVAILABLE: 'ACCEPTANCE_NATIVE_UNAVAILABLE',
  UNSAFE_TEMP: 'ACCEPTANCE_UNSAFE_TEMP',
} as const;
export type AcceptanceCode =
  (typeof ACCEPTANCE_CODES)[keyof typeof ACCEPTANCE_CODES];
export const ACCEPTANCE = {
  schemaVersion: 1,
  controlRefillMs:
    (CONTROL_CAPACITY.peerBurst * CONTROL_CAPACITY.millisecondsPerSecond) /
    CONTROL_CAPACITY.peerRate,
  origin: 'http://127.0.0.1',
  baseUrl: 'http://127.0.0.1/v1',
  unusedHttpOrigin: 'http://127.0.0.1:1',
  temporaryPrefix: 'gyblos-node-acceptance-',
  renewalCycles: 3,
  syntheticMemoryBytes: 8 * 1024 ** 3,
  queryMs: 5000,
  maxRunMs: 20 * 60_000,
} as const;
