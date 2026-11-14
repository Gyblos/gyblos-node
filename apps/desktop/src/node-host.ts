// Owns fixed local-node IPC and quit settlement; never accepts paths or configuration.
import { join } from 'node:path';

import { ipcMain, utilityProcess, type BrowserWindow } from 'electron';

import { createNodeHandlers } from './node-handlers';
import { createDesktopNodeSession } from './node-session';
import { LOCAL_NODE } from './node-status';

export function registerDesktopNode(
  window: BrowserWindow,
  directory: string,
  signal: AbortSignal,
) {
  const session = createDesktopNodeSession(
    () =>
      utilityProcess.fork(join(directory, 'node-worker.cjs'), [], {
        env: {},
        stdio: 'ignore',
      }),
    signal,
  );
  const handlers = createNodeHandlers(session, {
    contents: window.webContents,
    mainFrame: () => window.webContents.mainFrame,
    destroyed: () => window.isDestroyed(),
  });
  ipcMain.handle(LOCAL_NODE.STATUS_CHANNEL, (event, ...args: unknown[]) =>
    handlers.summary(event, args),
  );
  ipcMain.handle(LOCAL_NODE.RETRY_CHANNEL, (event, ...args: unknown[]) =>
    handlers.retry(event, args),
  );
  session.start();
  return session;
}
