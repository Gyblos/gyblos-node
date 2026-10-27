// Static internal collection failures; never exposes paths, secrets or native errors.
import { WALLET_LIBRARY_ERROR } from './constants.js';

export class WalletLibraryError extends Error {
  constructor(
    readonly code: (typeof WALLET_LIBRARY_ERROR)[keyof typeof WALLET_LIBRARY_ERROR],
  ) {
    super('Wallet library operation could not complete.');
    this.name = 'WalletLibraryError';
  }
}
export function checkLibraryCancellation(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.CANCELLED);
}
