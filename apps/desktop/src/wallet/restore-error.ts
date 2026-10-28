// Static restoration failures; never include secrets, passwords or filesystem paths.
import type { WalletRestoreErrorCode } from './constants';

export class WalletRestoreError extends Error {
  constructor(readonly code: WalletRestoreErrorCode) {
    super(code);
    this.name = 'WalletRestoreError';
  }
}
