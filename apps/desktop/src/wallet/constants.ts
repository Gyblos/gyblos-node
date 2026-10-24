// Canonical desktop wallet states and local record limits; no payment policy.
import { BACKUP } from './backup/constants.js';

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

// Pinned Chromium compatibility parameters, not wallet credentials. Public weak
// passwords must never be accepted as local custody, even with a secure backend.
export const STORAGE_CBC = {
  MAC_PREFIX: 'v10',
  LINUX_PREFIX: 'v11',
  PREFIX_BYTES: 3,
  ALGORITHM: 'aes-128-cbc',
  KEY_BYTES: 16,
  IV_BYTES: 16,
  IV_BYTE: 32,
  LEGACY_SALT: 'saltysalt',
  LEGACY_ITERATIONS: 1,
  LEGACY_DIGEST: 'sha1',
  LEGACY_PASSWORDS: ['', 'peanuts'],
} as const;

export const BACKUP_ACTION = { CREATE: 'create', VERIFY: 'verify' } as const;
export const BACKUP_RESULT = {
  SAVED: 'saved',
  VERIFIED: 'verified',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  BUSY: 'busy',
} as const;
export const BACKUP_FLOW = {
  CHANNEL: 'desktop:wallet-backup',
  MIN_PASSWORD_CHARACTERS: 12,
  MAX_PASSWORD_BYTES: BACKUP.MAX_PASSWORD_BYTES,
  FILENAME: 'gyblos-wallet-backup.json',
} as const;

export const WALLET_RESTORE_ERROR = {
  DESTINATION_EXISTS: 'WALLET_RESTORE_DESTINATION_EXISTS',
  UNAVAILABLE: 'WALLET_RESTORE_UNAVAILABLE',
  CANCELLED: 'WALLET_RESTORE_CANCELLED',
  BUSY: 'WALLET_RESTORE_BUSY',
  FAILED: 'WALLET_RESTORE_FAILED',
  RECOVERY_REQUIRED: 'WALLET_RESTORE_RECOVERY_REQUIRED',
} as const;
export type WalletRestoreErrorCode =
  (typeof WALLET_RESTORE_ERROR)[keyof typeof WALLET_RESTORE_ERROR];
