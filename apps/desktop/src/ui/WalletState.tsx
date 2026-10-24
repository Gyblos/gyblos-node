// Shares sanitized main-process wallet status across startup and Wallet.
// The UI cannot request a secret, signing, backup verification or funding.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import {
  parseWalletSummary,
  WALLET_STATUS,
  walletSummary,
  type WalletSummary,
} from '../wallet/model.js';

declare global {
  interface Window {
    desktopWallet?: { summary(): Promise<WalletSummary> };
  }
}

const WalletContext = createContext<WalletSummary>(
  walletSummary(WALLET_STATUS.LOADING),
);

export function DesktopWalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState(() =>
    walletSummary(WALLET_STATUS.LOADING),
  );
  useEffect(() => {
    let active = true;
    const request =
      window.desktopWallet?.summary() ??
      Promise.resolve(walletSummary(WALLET_STATUS.UNAVAILABLE));
    void request.then(
      (value) => {
        if (active) setWallet(parseWalletSummary(value));
      },
      () => {
        if (active) setWallet(walletSummary(WALLET_STATUS.UNAVAILABLE));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
  );
}

export function useDesktopWallet() {
  return useContext(WalletContext);
}
