// Owns fixed desktop host and compatibility-probe values.
export const RESPONSE_METRICS = {
  MAX_DURATION_MS: 86_400_000,
  MS_PER_SECOND: 1000,
  MAX_AMOUNT_CHARACTERS: 64,
  PERCENT_SCALE: 100,
} as const;
export const RESPONSE_COST_UNIT = {
  USD: 'USD',
  USDC: 'USDC',
  ATOMIC: 'atomic units',
} as const;
export const RESPONSE_COST_KIND = {
  RECORDED: 'recorded',
  SETTLED: 'settled',
} as const;
export const AGENT_CLIENT = {
  OPENCODE: 'OpenCode',
  CODEX: 'Codex',
  PI: 'Pi',
  CLAUDE_CODE: 'Claude Code',
  OTHER: 'Other tool',
} as const;
export const PAYPAL_AGENT_COPY = {
  KEY: 'api-key',
  URL: 'api-url',
  MODEL: 'model',
  EXAMPLE: 'api-example',
  PI_SETTINGS: 'pi-settings',
  CLAUDE_POWERSHELL: 'claude-powershell',
} as const;
export const DESKTOP_AGENT_SERVER_NOT_RUNNING = 'ERR_SERVER_NOT_RUNNING';
export const PAYPAL_STATUS_POLL_TIMEOUT_MS = 5000;
export const PAYPAL_STATUS_POLL_MAX_OUTSTANDING = 2;
export const PAYPAL_AGENT_USAGE_STATE = {
  AVAILABLE: 'available',
  BUSY: 'busy',
  CHAT_PENDING: 'chat_pending',
  NEEDS_REVIEW: 'needs_review',
  EXPIRED: 'expired',
  ATTEMPTS_EXHAUSTED: 'attempts_exhausted',
  LIMIT_REACHED: 'limit_reached',
  KEY_LIMIT_REACHED: 'key_limit_reached',
  DISCONNECTING: 'disconnecting',
  DISCONNECT_FAILED: 'disconnect_failed',
} as const;
export type PaypalAgentUsageState =
  (typeof PAYPAL_AGENT_USAGE_STATE)[keyof typeof PAYPAL_AGENT_USAGE_STATE];
export const PAYMENT_METHOD = {
  USDC: 'usdc',
  PAYPAL: 'paypal-sandbox',
} as const;

export const PAYPAL_ACTION = {
  STATUS: 'status',
  CREATE: 'create',
  OPEN: 'open',
  APPROVE: 'approve',
  COMPLETE_RETURN: 'complete-return',
  COMPLETE_CANCEL: 'complete-cancel',
  SEND: 'send',
  ACKNOWLEDGE: 'acknowledge',
  FINISH: 'finish',
  CHECK_VOID: 'check-void',
  REVIEW_AND_SETTLE: 'review-and-settle',
  ABANDON: 'abandon',
} as const;

export const PAYPAL_DESKTOP_ERROR = {
  DENIED: 'denied',
  INVALID: 'invalid',
  INVALID_PROMPT: 'invalid-prompt',
  UNAVAILABLE: 'unavailable',
  NOT_APPROVED: 'not-approved',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
} as const;

export const PAYPAL_AGENT_ACTION = {
  STATUS: 'status',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
} as const;

export const PAYPAL_AGENT_ERROR = {
  DENIED: 'denied',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
  MODEL_UNAVAILABLE: 'model_unavailable',
  NEW_SESSION_REQUIRED: 'new_session_required',
} as const;

export const PROBE_STATUS = {
  WAITING: 'waiting',
  PASSED: 'passed',
  FAILED: 'failed',
} as const;
export const DESKTOP = {
  CHANNEL: 'desktop:probe',
  FINISH_ACK: 'desktop:probe-finished',
  TITLE: 'Gyblos',
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

export const WINDOW_PLATFORM = {
  MAC: 'darwin',
  WINDOWS: 'win32',
  LINUX: 'linux',
  WEB: 'web',
} as const;
export const WINDOW_CHROME = {
  HEIGHT: 44,
  TRAFFIC_LIGHT_X: 16,
  TRAFFIC_LIGHT_Y: 15,
  OVERLAY_COLOR: '#00000000',
  // Neutral control glyphs remain legible against both approved app themes.
  OVERLAY_SYMBOL: '#808080',
} as const;

export const STARTUP_WINDOW = {
  WIDTH: 420,
  HEIGHT: 250,
  QUERY: 'startup',
  QUERY_VALUE: '1',
  BARS: 20,
  SETUP_HEIGHT: 420,
} as const;

export const LOCAL_NODE_STATE = {
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
} as const;
export const LOCAL_NODE = {
  STATUS_CHANNEL: 'desktop:node-status',
  RETRY_CHANNEL: 'desktop:node-retry',
  READY: 'node:ready',
  STOP: 'node:stop',
  START_TIMEOUT_MS: 15000,
  STOP_TIMEOUT_MS: 5000,
  POLL_MS: 600,
} as const;

// Local activity is descriptive metadata, never payment authority.
export const DESKTOP_ACTIVITY = {
  REFERENCE_VERSION: 2,
  REFERENCES_CHANNEL: 'desktop:activity-references',
  COPY_REFERENCE_CHANNEL: 'desktop:activity-copy-reference',
  CHANNEL: 'desktop:activity:summary',
  IO_TIMEOUT_MS: 1000,
  VERSION: 1,
  MAX_SESSIONS: 1000,
  MAX_BYTES: 1_048_576,
  DISPLAY_ID_CHARACTERS: 6,
  POLL_MS: 2000,
} as const;

export const CHAT_STORAGE = {
  VERSION: 1,
  LOAD_CHANNEL: 'desktop:conversations:load',
  SAVE_CHANNEL: 'desktop:conversations:save',
  STATUS_CHANNEL: 'desktop:conversations:status',
  MAX_CONVERSATIONS: 200,
  MAX_MESSAGES: 5000,
  MAX_TEXT_CHARACTERS: 1_000_000,
  MAX_TITLE_CHARACTERS: 512,
  MAX_MODEL_CHARACTERS: 512,
  MAX_BYTES: 16_777_216,
  POLL_MS: 500,
  LOAD_TIMEOUT_MS: 2000,
  ID_PATTERN: /^[A-Za-z0-9._:-]{1,128}$/,
} as const;
export const CHAT_STORAGE_STATE = {
  LOADING: 'loading',
  SAVING: 'saving',
  SAVED: 'saved',
  UNAVAILABLE: 'unavailable',
} as const;

export type ChatArchiveState =
  (typeof CHAT_STORAGE_STATE)[keyof typeof CHAT_STORAGE_STATE];

// Preserves the local hackathon engine; network agents discover their models from the buyer.
export const PAYPAL_SANDBOX_AGENT_MODEL = 'gpt-oss:20b';
