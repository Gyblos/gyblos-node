// Owns the operator wallet roles and the devnet configuration-file contract.
// Evidence, payment policy and lab orchestration do not belong here.
export const WALLET_ROLES = {
  BUYER: 'buyer',
  SELLER: 'seller',
  AUTHORIZER: 'authorizer',
  FACILITATOR: 'facilitator',
  MINT: 'mint',
} as const;

export const CONFIG_ASSET_LABELS = {
  DEVNET_USDC: 'devnet-usdc',
  TEST_TOKEN: 'devnet-test-token',
} as const;

export const CONFIG_SCHEMA_VERSION = 1;

export type WalletRole = (typeof WALLET_ROLES)[keyof typeof WALLET_ROLES];

export type ConfigAssetLabel =
  (typeof CONFIG_ASSET_LABELS)[keyof typeof CONFIG_ASSET_LABELS];
