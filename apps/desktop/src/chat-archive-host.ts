// Connects private conversation storage to fixed Electron IPC and bounded quit cleanup.
import { ipcMain, type BrowserWindow } from 'electron';

import { createChatArchiveHandlers } from './chat-archive-handlers';
import { createChatArchiveStorage } from './chat-archive-storage';
import { CHAT_STORAGE } from './constants';

export function registerChatArchive(window: BrowserWindow, profile: string) {
  const storage = createChatArchiveStorage(profile);
  const handlers = createChatArchiveHandlers(storage.store, {
    contents: window.webContents,
    mainFrame: () => window.webContents.mainFrame,
    destroyed: () => window.isDestroyed(),
  });
  ipcMain.handle(CHAT_STORAGE.LOAD_CHANNEL, (event, ...args: unknown[]) =>
    handlers.load(event, args),
  );
  ipcMain.handle(CHAT_STORAGE.SAVE_CHANNEL, (event, ...args: unknown[]) =>
    handlers.save(event, args),
  );
  ipcMain.handle(CHAT_STORAGE.STATUS_CHANNEL, (event, ...args: unknown[]) =>
    handlers.status(event, args),
  );
  return {
    async close() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          storage.close().catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CHAT_STORAGE.LOAD_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
