// Fixed wallet IPC handlers authenticate the current window/main frame and arity.
// Null sessions (smoke) and foreign callers cannot start custody operations.
import { BACKUP_RESULT } from './backup-flow-model';
import { WALLET_STATUS, walletSummary } from './model';
import type { createDesktopWalletSession } from './session';
import {
  unavailableCollection,
  WALLET_SETTINGS_RESULT,
} from './settings-model';

type WalletHandlerSession = Pick<
  ReturnType<typeof createDesktopWalletSession>,
  'summary' | 'collection' | 'run' | 'backup' | 'copy'
>;
interface WalletSender {
  sender: unknown;
  senderFrame: unknown;
}
interface WalletWindow {
  contents: unknown;
  mainFrame(): unknown;
  destroyed(): boolean;
}
export function createWalletHandlers(
  session: WalletHandlerSession | null,
  window: WalletWindow,
  writeText: (text: string) => void,
) {
  function accepts(
    event: WalletSender,
    args: readonly unknown[],
    count: number,
  ) {
    return (
      session !== null &&
      !window.destroyed() &&
      event.sender === window.contents &&
      event.senderFrame === window.mainFrame() &&
      args.length === count
    );
  }
  return {
    summary: (event: WalletSender, args: readonly unknown[]) =>
      accepts(event, args, 0) && session
        ? session.summary()
        : Promise.resolve(walletSummary(WALLET_STATUS.UNAVAILABLE)),
    collection: (event: WalletSender, args: readonly unknown[]) =>
      accepts(event, args, 0) && session
        ? session.collection()
        : Promise.resolve(unavailableCollection()),
    manage: (event: WalletSender, args: readonly unknown[]) =>
      accepts(event, args, 1) && session
        ? session.run(args[0])
        : Promise.resolve(WALLET_SETTINGS_RESULT.FAILED),
    backup: (event: WalletSender, args: readonly unknown[]) =>
      accepts(event, args, 1) && session
        ? session.backup(args[0])
        : Promise.resolve(BACKUP_RESULT.FAILED),
    copy: (event: WalletSender, args: readonly unknown[]) =>
      accepts(event, args, 1) && session
        ? session.copy(args, writeText)
        : Promise.resolve(false),
  };
}
