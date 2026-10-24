// Internal Node-only restoration into an absent wallet destination; no UI, IPC or funding.
import { WALLET_RESTORE_ERROR } from './constants.js';
import type { WalletSummary } from './model.js';
import type { WalletProtection } from './protection.js';
import { WalletRestoreError } from './restore-error.js';

export { WALLET_RESTORE_ERROR } from './constants.js';
export { WalletRestoreError } from './restore-error.js';

export function createWalletRestorer(
  _root: string,
  _protection: WalletProtection | null,
) {
  return {
    async restore(
      _file: Uint8Array,
      _password: string,
      _signal?: AbortSignal,
    ): Promise<WalletSummary> {
      throw new WalletRestoreError(WALLET_RESTORE_ERROR.UNAVAILABLE);
    },
  };
}
