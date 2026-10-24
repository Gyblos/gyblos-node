// Canonical desktop wallet states and local record limits; no payment policy.
export const WALLET_STATUS = {
  LOADING: 'loading',
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  RECOVERY_REQUIRED: 'recovery-required',
} as const;
export const WALLET = {
  CHANNEL: 'desktop:wallet-status',
  DIRECTORY: 'wallet-v1',
  RECORD: 'wallet.enc',
  STAGING: 'wallet.pending',
  FORMAT: 1,
  MAX_RECORD_BYTES: 16384,
  MAX_SECRET_BYTES: 1024,
  PRIVATE_DIRECTORY: 0o700,
  PRIVATE_FILE: 0o600,
  PERMISSION_MASK: 0o777,
  APP_NAME: 'Gyblos',
  PROFILE: 'gyblos-desktop',
  ROOT: 'gyblos-wallet',
} as const;
export const WALLET_PROVIDER = {
  MAC: 'macos-keychain',
  WINDOWS: 'windows-dpapi',
  LINUX: 'linux-secret-store',
} as const;
export type WalletProvider =
  (typeof WALLET_PROVIDER)[keyof typeof WALLET_PROVIDER];
