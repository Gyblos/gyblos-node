// Copies only the selected current public address; no arbitrary text or key access.
import { WALLET_STATUS } from './constants.js';
import type { WalletSummary } from './model.js';

export function copyPublicWalletAddress(
  current: WalletSummary,
  args: readonly unknown[],
  writeText: (text: string) => void,
): boolean {
  if (
    current.status !== WALLET_STATUS.READY ||
    !current.address ||
    args.length !== 1 ||
    args[0] !== current.address
  )
    return false;
  try {
    writeText(current.address);
    return true;
  } catch {
    return false;
  }
}
