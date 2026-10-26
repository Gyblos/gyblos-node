// Shares sanitized main-process wallet status across startup and Wallet.
// The UI cannot receive a key, file contents or signing/funding capability.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type {
  BackupRequest,
  BackupResult,
} from '../wallet/backup-flow-model.js';
import {
  parseWalletSummary,
  WALLET_STATUS,
  walletSummary,
  type WalletSummary,
} from '../wallet/model.js';

declare global {
  interface Window {
    desktopWallet?: {
      summary(): Promise<WalletSummary>;
      backup(request: BackupRequest): Promise<BackupResult>;
    };
  }
}

const WalletContext = createContext<{
  wallet: WalletSummary;
  refresh(): Promise<void>;
}>({ wallet: walletSummary(WALLET_STATUS.LOADING), refresh: async () => {} });

export function DesktopWalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState(() =>
    walletSummary(WALLET_STATUS.LOADING),
  );
  const active = useRef(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    let current = walletSummary(WALLET_STATUS.UNAVAILABLE);
    try {
      current = parseWalletSummary(await window.desktopWallet?.summary());
    } catch {
      // A failed public-status request must never leave a stale verified badge.
    }
    if (active.current && request === sequence.current) setWallet(current);
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, [refresh]);
  return (
    <WalletContext.Provider value={{ wallet, refresh }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useDesktopWallet() {
  return useContext(WalletContext).wallet;
}
export function useRefreshDesktopWallet() {
  return useContext(WalletContext).refresh;
}
