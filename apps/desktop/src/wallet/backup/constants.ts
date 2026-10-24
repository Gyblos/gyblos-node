// Owns the bounded portable format, independent of native wallet encryption.
export const BACKUP = {
  FORMAT: 'gyblos-wallet-backup',
  VERSION: 1,
  KDF: 'scrypt-n131072-r8-p1',
  CIPHER: 'aes-256-gcm',
  KEY_FORMAT: 'pkcs8-ed25519',
  COST: 131072,
  BLOCK_SIZE: 8,
  PARALLELISM: 1,
  MAX_MEMORY: 192 * 1024 * 1024,
  KEY_BYTES: 32,
  SALT_BYTES: 16,
  NONCE_BYTES: 12,
  TAG_BYTES: 16,
  MAX_FILE_BYTES: 8192,
  MAX_PASSWORD_BYTES: 1024,
  MIN_PASSWORD_BYTES: 12,
  FIELDS: 'cipher,ciphertext,format,kdf,keyFormat,nonce,salt,tag,version',
} as const;
export const BACKUP_ERROR = {
  INVALID_INPUT: 'BACKUP_INVALID_INPUT',
  INVALID_FILE: 'BACKUP_INVALID_FILE',
  AUTHENTICATION: 'BACKUP_AUTHENTICATION_FAILED',
  IDENTITY: 'BACKUP_IDENTITY_MISMATCH',
  BUSY: 'BACKUP_BUSY',
  CANCELLED: 'BACKUP_CANCELLED',
} as const;
export type BackupErrorCode = (typeof BACKUP_ERROR)[keyof typeof BACKUP_ERROR];
