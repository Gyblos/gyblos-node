// Exposes public startup percentages only to the loading window's current main frame.
// Closing that window or quitting removes its read-only IPC handler.
import { ipcMain, type BrowserWindow } from 'electron';

import { STARTUP_PROGRESS } from './constants';
import { createStartupProgress } from './startup-progress';

export function registerStartupProgress(
  window: BrowserWindow,
  signal: AbortSignal,
) {
  const progress = createStartupProgress(
    {
      contents: window.webContents,
      mainFrame: () => window.webContents.mainFrame,
      destroyed: () => window.isDestroyed(),
    },
    (percentage) =>
      window.webContents.mainFrame.send(
        STARTUP_PROGRESS.CHANGED_CHANNEL,
        percentage,
      ),
    signal,
  );
  if (signal.aborted || window.isDestroyed()) return progress.publish;
  ipcMain.handle(STARTUP_PROGRESS.STATUS_CHANNEL, (event, ...args: unknown[]) =>
    progress.read(event, args),
  );
  const close = () => {
    ipcMain.removeHandler(STARTUP_PROGRESS.STATUS_CHANNEL);
    signal.removeEventListener('abort', close);
  };
  window.once('closed', close);
  signal.addEventListener('abort', close, { once: true });
  return progress.publish;
}
