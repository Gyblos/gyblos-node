// Coordinates first-run choice before any automatic wallet generation.
// Existing wallets are never restore targets; all state returned is public-only.
import { WALLET_STATUS, walletSummary } from './model.js';
import type { WalletProtection } from './protection.js';
import { SETUP_STATUS, setupView } from './setup-model.js';

export function createWalletSetup(
  root: string,
  protection: WalletProtection | null,
  dialogs: { select(): Promise<string | null> },
  signal: AbortSignal,
) {
  return {
    summary: Promise.resolve(walletSummary(WALLET_STATUS.UNAVAILABLE)),
    state: async () => setupView(SETUP_STATUS.CHOICE),
    run: async (value: unknown) => setupView(SETUP_STATUS.CHOICE),
    settled: async () => {},
  };
}
