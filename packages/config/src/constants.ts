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
