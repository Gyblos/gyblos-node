// Static restoration failures; never include secrets, passwords or filesystem paths.
import type { WalletRestoreErrorCode } from './constants.js';

export class WalletRestoreError extends Error {
  constructor(readonly code: WalletRestoreErrorCode) {
    super(code);
    this.name = 'WalletRestoreError';
  }
}
