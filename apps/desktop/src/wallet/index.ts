// Public testable desktop wallet contracts; importing them never initializes a wallet.
export { createWalletService } from './service';
export {
  focusExistingWindow,
  prepareWalletProfile,
  waitForWalletBeforeQuit,
} from './lifecycle';
export {
  parseWalletSummary,
  WALLET,
  WALLET_STATUS,
  WALLET_PROVIDER,
} from './model';
export {
  walletProtection,
  type WalletProtection,
  type SafeStoragePort,
} from './protection';

export { createBackupFlow, type BackupDialogs } from './backup-flow';
export {
  BACKUP_ACTION,
  BACKUP_RESULT,
  BACKUP_FLOW,
  parseBackupRequest,
  parseBackupResult,
} from './backup-flow-model';

export { BACKUP_VERIFICATION } from './constants';

export { copyPublicWalletAddress } from './copy-address';
