// Bounds and fixed IPC names for the desktop's local-buyer spending permission.
export const DESKTOP_X402 = {
  VERSION: 1,
  CHANNEL: 'desktop:x402',
  MAX_BYTES: 1048576,
  MAX_RECORDS: 1000,
  MAX_ID: 128,
  MAX_PROMPT: 16384,
  MAX_RESPONSE: 262144,
  REQUEST_MS: 180000,
  STATUS_MS: 10000,
  EXPLORER: 'https://explorer.solana.com/tx/',
  ATOMIC_DECIMALS: 6,
  AMOUNT_SCALE: 1000000,
  SIGNATURE_PREFIX: 8,
  SIGNATURE_SUFFIX: 6,
  MIN_TOKEN_LENGTH: 16,
  MAX_TOKEN_LENGTH: 512,
  START_MS: 60000,
  STOP_MS: 15000,
  MAX_RELAY_TOKEN: 8192,
  MAX_RELAYS_LENGTH: 8192,
  MAX_TRANSPORT_ADDRESS: 2048,
  SERVICE_FILE: 'buyer-service.cjs',
} as const;
export const X402_ACTION = {
  STATUS: 'status',
  CONNECT: 'connect',
  AUTHORIZE: 'authorize',
  SEND: 'send',
  FINISH: 'finish',
  EXPLORER: 'explorer',
  CHOOSE_HOME: 'choose-home',
  START_BUYER: 'start-buyer',
  COPY_PAYER: 'copy-payer',
  COPY_MINT: 'copy-mint',
} as const;

export const USDC_API = {
  CHANNEL: 'desktop:usdc-api-keys',
  POLL_MS: 3000,
  DEFAULT_LIMIT: '0.01',
} as const;
export const USDC_API_ACTION = {
  STATUS: 'status',
  CREATE: 'create',
  REVOKE: 'revoke',
  COPY_KEY: 'copy-key',
  COPY_URL: 'copy-url',
  COPY_EXAMPLE: 'copy-example',
  PREVIEW_AGENT: 'preview-agent',
  COPY_AGENT: 'copy-agent',
  WRITE_AGENT: 'write-agent',
} as const;
export type UsdcApiAction =
  (typeof USDC_API_ACTION)[keyof typeof USDC_API_ACTION];
