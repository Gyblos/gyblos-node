// Public Settings contracts only; never imports Node, paths, crypto or keys.
import { parseBackupRequest, type BackupRequest } from './backup-flow-model';
import {
  WALLET_LIBRARY,
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
  WALLET_STATUS,
} from './constants';
import {
  parseWalletSummary,
  walletSummary,
  type WalletSummary,
} from './model';
import { validSetupPassword } from './setup-model';

export {
  WALLET_SETTINGS,
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
} from './constants';
export type WalletSettingsResult =
  (typeof WALLET_SETTINGS_RESULT)[keyof typeof WALLET_SETTINGS_RESULT];
export type WalletSettingsRequest =
  | { action: typeof WALLET_SETTINGS_ACTION.RESTORE; password: string }
  | { action: typeof WALLET_SETTINGS_ACTION.SELECT; address: string };
export interface WalletCollection {
  wallet: WalletSummary;
  wallets: WalletSummary[];
}
export interface ActiveBackupRequest extends BackupRequest {
  address: string;
}
export function unavailableCollection(
  status: WalletSummary['status'] = WALLET_STATUS.UNAVAILABLE,
): WalletCollection {
  return { wallet: walletSummary(status), wallets: [] };
}
function validAddress(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
  );
}
export function parseWalletSettingsRequest(
  value: unknown,
): WalletSettingsRequest | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('action' in value)
  )
    return null;
  if (
    value.action === WALLET_SETTINGS_ACTION.RESTORE &&
    Object.keys(value).sort().join(',') === 'action,password' &&
    'password' in value &&
    typeof value.password === 'string' &&
    validSetupPassword(value.password)
  )
    return { action: value.action, password: value.password };
  if (
    value.action === WALLET_SETTINGS_ACTION.SELECT &&
    Object.keys(value).sort().join(',') === 'action,address' &&
    'address' in value &&
    validAddress(value.address)
  )
    return { action: value.action, address: value.address };
  return null;
}
export function parseActiveBackupRequest(
  value: unknown,
): ActiveBackupRequest | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'action,address,password' ||
    !('address' in value) ||
    !validAddress(value.address) ||
    !('action' in value) ||
    !('password' in value)
  )
    return null;
  const request = parseBackupRequest({
    action: value.action,
    password: value.password,
  });
  return request ? { ...request, address: value.address } : null;
}
export function parseWalletSettingsResult(
  value: unknown,
): WalletSettingsResult {
  return (
    Object.values(WALLET_SETTINGS_RESULT).find((result) => result === value) ??
    WALLET_SETTINGS_RESULT.FAILED
  );
}
export function parseWalletCollection(value: unknown): WalletCollection {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'wallet,wallets' ||
    !('wallet' in value) ||
    !('wallets' in value) ||
    !Array.isArray(value.wallets) ||
    value.wallets.length > WALLET_LIBRARY.MAX_IDENTITIES
  )
    return unavailableCollection();
  const wallet = parseWalletSummary(value.wallet);
  if (wallet.status !== WALLET_STATUS.READY)
    return value.wallets.length === 0
      ? { wallet, wallets: [] }
      : unavailableCollection();
  const wallets = value.wallets.map((item) => parseWalletSummary(item));
  const addresses = new Set(wallets.map((item) => item.address));
  if (
    addresses.size !== wallets.length ||
    wallets.some((item) => item.status !== WALLET_STATUS.READY) ||
    !wallets.some(
      (item) =>
        item.address === wallet.address &&
        item.backupVerified === wallet.backupVerified,
    )
  )
    return unavailableCollection();
  return { wallet, wallets };
}
