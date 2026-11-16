// Owns the fixed update bridge; only the main frame may open a validated release page.
import { app, ipcMain, shell, type BrowserWindow } from 'electron';

import { DESKTOP_UPDATE } from './constants';
import { checkDesktopUpdate } from './update-check';
import { createDesktopUpdateReader } from './update-session';

export function registerDesktopUpdate(
  window: BrowserWindow,
  signal: AbortSignal,
) {
  const current = app.getVersion();
  const read = createDesktopUpdateReader(current, () =>
    process.env.GYBLOS_UPDATE_CHECK === '0'
      ? Promise.resolve({ current, available: null })
      : checkDesktopUpdate(
          current,
          process.platform,
          process.arch,
          fetch,
          signal,
        ),
  );
  void read();
  ipcMain.handle(DESKTOP_UPDATE.CHANNEL, async (event, action: unknown) => {
    const validate = () => {
      if (
        signal.aborted ||
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Unsupported update request');
    };
    validate();
    if (action !== DESKTOP_UPDATE.STATUS && action !== DESKTOP_UPDATE.OPEN)
      throw new Error('Unsupported update action');
    const result = await read();
    validate();
    if (action === DESKTOP_UPDATE.OPEN && result.available && !signal.aborted)
      await shell.openExternal(DESKTOP_UPDATE.PAGE + result.available);
    return result;
  });
  signal.addEventListener(
    'abort',
    () => ipcMain.removeHandler(DESKTOP_UPDATE.CHANNEL),
    { once: true },
  );
}
