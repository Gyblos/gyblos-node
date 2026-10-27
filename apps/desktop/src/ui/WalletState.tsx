// Shares sanitized wallet collection and serial Settings actions with the renderer.
// The bridge exposes no paths, backup bytes, private keys or signing capability.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  BACKUP_RESULT,
  type BackupResult,
} from '../wallet/backup-flow-model';
import { WALLET_STATUS, type WalletSummary } from '../wallet/model';
import {
  parseWalletCollection,
  parseWalletSettingsResult,
  unavailableCollection,
  WALLET_SETTINGS_RESULT,
  type ActiveBackupRequest,
  type WalletCollection,
  type WalletSettingsRequest,
  type WalletSettingsResult,
} from '../wallet/settings-model';

declare global {
  interface Window {
    desktopWallet?: {
      summary(): Promise<WalletSummary>;
      collection(): Promise<WalletCollection>;
      manage(request: WalletSettingsRequest): Promise<WalletSettingsResult>;
      copyAddress(address: string): Promise<boolean>;
      backup(request: ActiveBackupRequest): Promise<BackupResult>;
    };
  }
}
function useWalletActions(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function run<T>(busyResult: T, failed: T, action: () => Promise<T>) {
    if (pending.current) return busyResult;
    pending.current = true;
    setBusy(true);
    try {
      return await action();
    } catch {
      return failed;
    } finally {
      await refresh();
      pending.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    manage: (request: WalletSettingsRequest) =>
      run(
        WALLET_SETTINGS_RESULT.BUSY,
        WALLET_SETTINGS_RESULT.FAILED,
        async () =>
          parseWalletSettingsResult(
            await window.desktopWallet?.manage(request),
          ),
      ),
    backup: (request: ActiveBackupRequest) =>
      run(
        BACKUP_RESULT.BUSY,
        BACKUP_RESULT.FAILED,
        async () =>
          (await window.desktopWallet?.backup(request)) ?? BACKUP_RESULT.FAILED,
      ),
  };
}
const WalletContext = createContext({
  collection: unavailableCollection(WALLET_STATUS.LOADING),
  refresh: async () => {},
  busy: false,
  manage: async (
    _request: WalletSettingsRequest,
  ): Promise<WalletSettingsResult> => WALLET_SETTINGS_RESULT.FAILED,
  backup: async (_request: ActiveBackupRequest): Promise<BackupResult> =>
    BACKUP_RESULT.FAILED,
});
export function DesktopWalletProvider({ children }: { children: ReactNode }) {
  const [collection, setCollection] = useState(() =>
    unavailableCollection(WALLET_STATUS.LOADING),
  );
  const active = useRef(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    let current = unavailableCollection();
    try {
      current = parseWalletCollection(await window.desktopWallet?.collection());
    } catch {
      /* Public status fails closed without a stale verified badge. */
    }
    if (active.current && request === sequence.current) setCollection(current);
  }, []);
  const actions = useWalletActions(refresh);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, [refresh]);
  return (
    <WalletContext.Provider value={{ collection, refresh, ...actions }}>
      {children}
    </WalletContext.Provider>
  );
}
export function useDesktopWallet() {
  return useContext(WalletContext).collection.wallet;
}
export function useDesktopWallets() {
  return useContext(WalletContext).collection.wallets;
}
export function useRefreshDesktopWallet() {
  return useContext(WalletContext).refresh;
}
export function useDesktopWalletActions() {
  const { busy, manage, backup } = useContext(WalletContext);
  return { busy, manage, backup };
}
