// Composes the sandbox service in Electron; the renderer never receives credentials or order links.
import { isAbsolute } from 'node:path';

import { app, ipcMain, shell, type BrowserWindow } from 'electron';

import { paypalSandboxSettings } from '@gyblos/config/paypal';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { openPaypalSandbox } from '@gyblos/node/paypal-startup';

import { openDesktopPaypalCallback } from './paypal-callback';
import { createDesktopPaypalHandlers } from './paypal-handlers';
import { DESKTOP_PAYPAL } from './paypal-model';
import { createDesktopPaypalRuntime } from './paypal-runtime';
import { createDesktopPaypalSession } from './paypal-session';
import { waitForWalletBeforeQuit } from './wallet/lifecycle';

async function startSandbox() {
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  const stateDirectory = process.env.PAYPAL_SANDBOX_STATE_DIRECTORY;
  if (
    !clientId ||
    !clientSecret ||
    !stateDirectory ||
    !isAbsolute(stateDirectory)
  )
    throw new Error('Sandbox configuration is unavailable.');
  const settings = paypalSandboxSettings(process.env);
  const callback = await openDesktopPaypalCallback();
  let sandbox: Awaited<ReturnType<typeof openPaypalSandbox>> | undefined;
  try {
    sandbox = await openPaypalSandbox({
      clientId,
      clientSecret,
      stateDirectory,
      returnOrigin: callback.origin,
      ollamaOrigin: settings.ollamaOrigin,
    });
    const model = (await sandbox.engine.describe()).name;
    const service = createDesktopPaypalSession(
      await createPaypalSession(sandbox),
      (url) => shell.openExternal(url),
    );
    const opened = sandbox;
    return {
      model,
      service: {
        ...service,
        async close() {
          try {
            await service.close();
          } finally {
            try {
              await opened.close();
            } finally {
              await callback.close();
            }
          }
        },
      },
    };
  } catch (error) {
    try {
      await sandbox?.close();
    } finally {
      await callback.close();
    }
    throw error;
  }
}

export function registerDesktopPaypal(window: BrowserWindow) {
  const runtime = createDesktopPaypalRuntime(startSandbox);
  const handlers = createDesktopPaypalHandlers(runtime.load, {
    contents: window.webContents,
    mainFrame: () => window.webContents.mainFrame,
    destroyed: () => window.isDestroyed(),
  });
  ipcMain.handle(DESKTOP_PAYPAL.CHANNEL, (event, ...args: unknown[]) =>
    handlers.run(event, args),
  );
  app.on(
    'before-quit',
    waitForWalletBeforeQuit(runtime.close, () => app.quit()),
  );
}
