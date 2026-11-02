// Composes the sandbox service in Electron; the renderer never receives credentials or order links.
import { isAbsolute } from 'node:path';

import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';

import { paypalSandboxSettings } from '@gyblos/config/paypal';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { openPaypalSandbox } from '@gyblos/node/paypal-startup';

import { openDesktopPaypalCallback } from './paypal-callback';
import { createDesktopPaypalCloseGuard } from './paypal-close-guard';
import { createDesktopPaypalHandlers } from './paypal-handlers';
import { DESKTOP_PAYPAL } from './paypal-model';
import { createDesktopPaypalRuntime } from './paypal-runtime';
import { createDesktopPaypalSession } from './paypal-session';

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
      deferEngineCheck: true,
    });
    const model = sandbox.model;
    const opened = sandbox;
    const service = createDesktopPaypalSession(
      await createPaypalSession(opened),
      (url) => shell.openExternal(url),
      {
        checkEngine: () => opened.engine.describe(),
      },
    );
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
  let allowUnconfirmedExit = false;
  let promptOpen = false;
  const guard = createDesktopPaypalCloseGuard(
    () =>
      !allowUnconfirmedExit && !!runtime.current()?.service.isCloseBlocked(),
    () => {
      if (promptOpen) return;
      promptOpen = true;
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          message: 'A PayPal Sandbox checkout or response is still open.',
          detail:
            'Finish or close the PayPal checkout before leaving. If a checkout stays open after Gyblos closes, another local process could receive its return details. An unfinished response may need manual review.',
          buttons: ['Keep open', 'Close anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then(({ response }) => {
          promptOpen = false;
          if (response !== 1) return;
          allowUnconfirmedExit = true;
          app.quit();
        })
        .catch(() => {
          promptOpen = false;
        });
    },
  );
  const handlers = createDesktopPaypalHandlers(runtime.load, {
    contents: window.webContents,
    mainFrame: () => window.webContents.mainFrame,
    destroyed: () => window.isDestroyed(),
  });
  ipcMain.handle(DESKTOP_PAYPAL.CHANNEL, (event, ...args: unknown[]) =>
    handlers.run(event, args),
  );
  window.on('close', guard);
  return { guard, close: runtime.close };
}
