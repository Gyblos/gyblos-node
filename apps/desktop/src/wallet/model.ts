// Public-only wallet status shared with preload and UI; never serializes a secret.
import { WALLET_STATUS } from './constants.js';

export interface WalletSummary {
  status: (typeof WALLET_STATUS)[keyof typeof WALLET_STATUS];
  address: string | null;
  backupVerified: false;
  fundingEnabled: false;
}

export function walletSummary(
  status: WalletSummary['status'],
  address: string | null = null,
): WalletSummary {
  return { status, address, backupVerified: false, fundingEnabled: false };
}

export function parseWalletSummary(value: unknown): WalletSummary {
  const failed = () => walletSummary(WALLET_STATUS.UNAVAILABLE);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return failed();
  if (
    Object.keys(value).sort().join(',') !==
    'address,backupVerified,fundingEnabled,status'
  )
    return failed();
  if (
    !('status' in value) ||
    !('address' in value) ||
    !('backupVerified' in value) ||
    !('fundingEnabled' in value) ||
    value.backupVerified !== false ||
    value.fundingEnabled !== false
  )
    return failed();
  const status = Object.values(WALLET_STATUS).find(
    (item) => item === value.status,
  );
  if (!status) return failed();
  if (status === WALLET_STATUS.READY) {
    if (
      typeof value.address !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.address)
    )
      return failed();
    return walletSummary(status, value.address);
  }
  return value.address === null ? walletSummary(status) : failed();
}

export { WALLET, WALLET_STATUS, WALLET_PROVIDER } from './constants.js';
