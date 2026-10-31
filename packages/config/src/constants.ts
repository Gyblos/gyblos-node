// Owns configuration labels and typed path failures shared with applications.
// Evidence, payment policy and lab orchestration do not belong here.
export const CONFIG_ASSET_LABELS = {
  DEVNET_USDC: 'devnet-usdc',
  TEST_TOKEN: 'devnet-test-token',
} as const;

export type ConfigAssetLabel =
  (typeof CONFIG_ASSET_LABELS)[keyof typeof CONFIG_ASSET_LABELS];

export const CONFIG_PATH_ERROR = {
  INVALID_WALLET_LIBRARY_ADDRESS: 'CONFIG_INVALID_WALLET_LIBRARY_ADDRESS',
} as const;
export const PAYPAL_SANDBOX = {
  currency: 'USD',
  price: '1.00',
  port: 8765,
  maxPort: 65535,
  ollamaOrigin: 'http://127.0.0.1:11434/',
} as const;
export const PAYPAL_CONFIG_ERROR = 'PAYPAL_CONFIG_INVALID';
