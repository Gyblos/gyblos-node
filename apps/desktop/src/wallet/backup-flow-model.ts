// Owns the sanitized backup interaction contract; no Node or secret imports.
import { BACKUP } from './backup/constants.js';

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
export type BackupAction = (typeof BACKUP_ACTION)[keyof typeof BACKUP_ACTION];
export type BackupResult = (typeof BACKUP_RESULT)[keyof typeof BACKUP_RESULT];
export interface BackupRequest {
  action: BackupAction;
  password: string;
}
export function parseBackupRequest(value: unknown): BackupRequest | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'action,password' ||
    !('action' in value) ||
    !('password' in value) ||
    typeof value.password !== 'string' ||
    value.password.length < BACKUP_FLOW.MIN_PASSWORD_CHARACTERS ||
    new TextEncoder().encode(value.password).length >
      BACKUP_FLOW.MAX_PASSWORD_BYTES
  )
    return null;
  const action = Object.values(BACKUP_ACTION).find(
    (item) => item === value.action,
  );
  return action ? { action, password: value.password } : null;
}
export function parseBackupResult(value: unknown): BackupResult {
  return (
    Object.values(BACKUP_RESULT).find((item) => item === value) ??
    BACKUP_RESULT.FAILED
  );
}
