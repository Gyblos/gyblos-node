// Static portable-codec errors; never include passwords, keys or native errors.
import type { BackupErrorCode } from './constants.js';

export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode) {
    super(code);
    this.name = 'BackupError';
  }
}
