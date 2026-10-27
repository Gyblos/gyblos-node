// Wires the Electron window to the tested automatic wallet session and fixed IPC handlers.
// File pickers belong to the host; renderer startup never chooses or exports a wallet.
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  type BrowserWindow,
} from 'electron';

import { BACKUP_FLOW } from './backup-flow-model';
import { WALLET } from './constants';
import { createWalletHandlers } from './handlers';
import { waitForWalletBeforeQuit } from './lifecycle';
import { walletProtection } from './protection';
import { createDesktopWalletSession } from './session';
import { unavailableCollection, WALLET_SETTINGS } from './settings-model';

function walletDialogs(window: BrowserWindow) {
  return {
    async approve() {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Wallet backup',
        message: 'Save or verify your encrypted backup?',
        detail: 'Keep the file and password safe. Gyblos cannot recover them.',
        buttons: ['Cancel', 'Continue'],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
    async save() {
      const result = await dialog.showSaveDialog(window, {
        title: 'Save encrypted wallet backup',
        defaultPath: BACKUP_FLOW.FILENAME,
        filters: [{ name: 'Gyblos encrypted backup', extensions: ['json'] }],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    async select() {
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose encrypted wallet backup',
        properties: ['openFile'],
        filters: [{ name: 'Gyblos encrypted backup', extensions: ['json'] }],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  };
}
export function registerDesktopWallet(
  window: BrowserWindow,
  root: string,
  smoke: boolean,
  signal: AbortSignal,
) {
  const session = smoke
    ? null
    : createDesktopWalletSession(
        root,
        walletProtection(process.platform, safeStorage),
        walletDialogs(window),
        signal,
      );
  const handlers = createWalletHandlers(
    session,
    {
      contents: window.webContents,
      mainFrame: () => window.webContents.mainFrame,
      destroyed: () => window.isDestroyed(),
    },
    (text) => clipboard.writeText(text),
  );
  ipcMain.handle(WALLET.CHANNEL, (event, ...args: unknown[]) =>
    handlers.summary(event, args),
  );
  ipcMain.handle(
    WALLET_SETTINGS.COLLECTION_CHANNEL,
    (event, ...args: unknown[]) => handlers.collection(event, args),
  );
  ipcMain.handle(WALLET_SETTINGS.CHANNEL, (event, ...args: unknown[]) =>
    handlers.manage(event, args),
  );
  ipcMain.handle(WALLET.COPY_CHANNEL, (event, ...args: unknown[]) =>
    handlers.copy(event, args),
  );
  ipcMain.handle(BACKUP_FLOW.CHANNEL, (event, ...args: unknown[]) =>
    handlers.backup(event, args),
  );
  if (session)
    app.on(
      'before-quit',
      waitForWalletBeforeQuit(
        () => session.settled(),
        () => app.quit(),
      ),
    );
  return session?.ready ?? Promise.resolve(unavailableCollection());
}
