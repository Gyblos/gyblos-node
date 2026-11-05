// Composes the sandbox service in Electron; the renderer never receives credentials or order links.
import { isAbsolute } from 'node:path';

import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
} from 'electron';

import { paypalSandboxSettings } from '@gyblos/config/paypal';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { openPaypalSandbox } from '@gyblos/node/paypal-startup';

import { createDesktopPaypalAgentAccess } from './paypal-agent-access';
import { createDesktopPaypalAgentHandlers } from './paypal-agent-handlers';
import { DESKTOP_PAYPAL_AGENT } from './paypal-agent-model';
import { startDesktopPaypalAgent } from './paypal-agent-server';
import { openDesktopPaypalCallback } from './paypal-callback';
import { createDesktopPaypalCloseGuard } from './paypal-close-guard';
import { createDesktopPaypalHandlers } from './paypal-handlers';
import {
  DESKTOP_PAYPAL,
  paypalFinishDialog,
  paypalReviewDialog,
} from './paypal-model';
import { createDesktopPaypalRuntime } from './paypal-runtime';
import { createDesktopPaypalSession } from './paypal-session';

function showPaypalReturn(
  window: BrowserWindow,
  service: ReturnType<typeof createDesktopPaypalSession> | undefined,
  value: { state: string; token?: string },
  cancelled: boolean,
) {
  if (window.isDestroyed() || !service) return;
  const matched = cancelled
    ? service.noteCancelledReturn(value)
    : service.noteApprovedReturn(value);
  if (!matched) return;
  if (window.isMinimized()) window.restore();
  window.show();
  app.focus({ steal: true });
  window.focus();
  window.webContents.send(
    cancelled ? DESKTOP_PAYPAL.CANCEL_CHANNEL : DESKTOP_PAYPAL.RETURN_CHANNEL,
  );
}

async function startSandbox(window: BrowserWindow) {
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
  let service: ReturnType<typeof createDesktopPaypalSession> | undefined;
  const callback = await openDesktopPaypalCallback(
    (value) => showPaypalReturn(window, service, value, false),
    (value) => showPaypalReturn(window, service, value, true),
  );
  let sandbox: Awaited<ReturnType<typeof openPaypalSandbox>> | undefined;
  try {
    sandbox = await openPaypalSandbox({
      clientId,
      clientSecret,
      stateDirectory,
      returnOrigin: callback.origin,
      ollamaOrigin: settings.ollamaOrigin,
      agentModel: DESKTOP_PAYPAL_AGENT.MODEL,
      deferEngineCheck: true,
    });
    const model = sandbox.model;
    const opened = sandbox;
    service = createDesktopPaypalSession(
      await createPaypalSession(opened),
      (url) => shell.openExternal(url),
      {
        checkEngine: () => opened.engine.describe(),
        checkAgentEngine: () => opened.agentEngine.describe(),
      },
    );
    const activeService = service;
    const agentAccess = createDesktopPaypalAgentAccess(
      activeService.status,
      async () => {
        await activeService.prepareAgent();
        return startDesktopPaypalAgent(activeService, opened.agentEngine.model);
      },
      activeService.isBusy,
    );
    return {
      model,
      agentAccess,
      service: {
        ...activeService,
        async close() {
          const closingSession = activeService.close();
          try {
            await callback.close();
          } finally {
            try {
              await agentAccess.close();
            } finally {
              try {
                await closingSession;
              } finally {
                await opened.close();
              }
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
  const runtime = createDesktopPaypalRuntime(() => startSandbox(window));
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
          message: 'A PayPal Sandbox operation is still in progress.',
          detail:
            'A checkout, confirmation or response may still be open. Close every PayPal checkout tab before exiting. If a tab stays open after Gyblos closes, another local process could receive its return details. An unfinished response may need manual review.',
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
  const handlers = createDesktopPaypalHandlers(
    runtime.load,
    {
      contents: window.webContents,
      mainFrame: () => window.webContents.mainFrame,
      destroyed: () => window.isDestroyed(),
    },
    async (ticket) => {
      const result = await dialog.showMessageBox(
        window,
        paypalReviewDialog(ticket),
      );
      return result.response === 1 && !window.isDestroyed();
    },
    async (summary) => {
      const result = await dialog.showMessageBox(
        window,
        paypalFinishDialog(summary),
      );
      return result.response === 1 && !window.isDestroyed();
    },
  );
  const agentHandlers = createDesktopPaypalAgentHandlers(
    runtime.load,
    {
      contents: window.webContents,
      mainFrame: () => window.webContents.mainFrame,
      destroyed: () => window.isDestroyed(),
    },
    runtime.current,
    (text) => clipboard.writeText(text),
  );
  ipcMain.handle(DESKTOP_PAYPAL.CHANNEL, (event, ...args: unknown[]) =>
    handlers.run(event, args),
  );
  ipcMain.handle(DESKTOP_PAYPAL_AGENT.CHANNEL, (event, ...args: unknown[]) =>
    agentHandlers.run(event, args),
  );
  ipcMain.handle(
    DESKTOP_PAYPAL_AGENT.COPY_CHANNEL,
    (event, ...args: unknown[]) => agentHandlers.copy(event, args),
  );
  window.on('close', guard);
  return { guard, close: runtime.close };
}
