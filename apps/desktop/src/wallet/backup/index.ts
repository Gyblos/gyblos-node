// Internal Node-only codec; never initializes or reads a live wallet.
import { BACKUP_ERROR, type BackupErrorCode } from './constants.js';

export { BACKUP, BACKUP_ERROR } from './constants.js';
export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode) {
    super(code);
    this.name = 'BackupError';
  }
}
export function createBackupCodec() {
  return {
    async seal(_secret: string, _password: string, _signal?: AbortSignal): Promise<Buffer> {
      throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
    },
    async open(_file: Uint8Array, _password: string, _address: string, _signal?: AbortSignal): Promise<string> {
      throw new BackupError(BACKUP_ERROR.INVALID_INPUT);
    },
  };
}
