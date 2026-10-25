// Owns the bounded desktop compatibility probe's values, not payment or discovery policy.
export const PROBE_STATUS = {
  WAITING: 'waiting',
  PASSED: 'passed',
  FAILED: 'failed',
} as const;
export const DESKTOP = {
  CHANNEL: 'desktop:probe',
  FINISH_ACK: 'desktop:probe-finished',
  TITLE: 'Gyblos · Desktop preview',
  ICON_FILE: 'assets/brand/gyblos-icon.png',
  DEADLINE_MS: 15000,
  STARTUP_DEADLINE_MS: 20000,
  EXIT_DELAY_MS: 300,
  SESSION_CLEANUP_RETRIES: 3,
  SESSION_CLEANUP_RETRY_MS: 100,
  WIDTH: 1000,
  HEIGHT: 740,
  MIN_WIDTH: 640,
  MIN_HEIGHT: 560,
  CYCLES: 2,
  MAX_BYTES: 64,
  PAYLOAD: 'gyblos-desktop-loopback-probe',
  SMOKE_FLAG: '--smoke',
} as const;

export const STARTUP_WINDOW = {
  WIDTH: 420,
  HEIGHT: 250,
  QUERY: 'startup',
  QUERY_VALUE: '1',
  BARS: 20,
  SETUP_HEIGHT: 420,
} as const;
