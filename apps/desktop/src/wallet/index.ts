// Public testable desktop wallet contracts; importing them never initializes a wallet.
export { createWalletService } from './service.js';
export {
  focusExistingWindow,
  prepareWalletProfile,
  waitForWalletBeforeQuit,
} from './lifecycle.js';
export {
  parseWalletSummary,
  WALLET,
  WALLET_STATUS,
  WALLET_PROVIDER,
} from './model.js';
export {
  walletProtection,
  type WalletProtection,
  type SafeStoragePort,
} from './protection.js';
