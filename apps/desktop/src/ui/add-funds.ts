// Validates the top-up UI only; never authorizes payment or changes wallet balances.
import { WALLET_STATUS, type WalletSummary } from '../wallet/model.js';
import { TOP_UP_STATUS } from './constants.js';

export { TOP_UP_STATUS } from './constants.js';
export type TopUpStatus = (typeof TOP_UP_STATUS)[keyof typeof TOP_UP_STATUS];

export function prepareTopUp(
  amount: string,
  wallet: WalletSummary,
): TopUpStatus {
  const value = Number(amount);
  if (
    !/^\d+(?:\.\d{1,2})?$/.test(amount) ||
    !Number.isFinite(value) ||
    value <= 0
  )
    return TOP_UP_STATUS.INVALID_AMOUNT;
  if (wallet.status !== WALLET_STATUS.READY)
    return TOP_UP_STATUS.WALLET_UNAVAILABLE;
  if (!wallet.backupVerified) return TOP_UP_STATUS.BACKUP_REQUIRED;
  return TOP_UP_STATUS.PAYMENT_UNAVAILABLE;
}
