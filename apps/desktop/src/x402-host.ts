// Main-frame bridge and private budget storage; the buyer runs as an isolated executable.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  clipboard,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
  type BrowserWindow,
} from 'electron';

import { desktopX402Paths } from '@gyblos/config/home';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import { createUsdcApiHandlers } from './usdc-api-handlers';
import { USDC_API } from './usdc-api-model';
import { X402Budget } from './x402-budget';
import { X402Client } from './x402-client';
import { createX402Handlers } from './x402-handlers';
import { buyerEnvironment, ManagedBuyer } from './x402-managed';
import { DESKTOP_X402 } from './x402-model';

function managedBuyer(
  window: BrowserWindow,
  directory: string,
  client: X402Client,
) {
  let selectedHome: string | null = null;
  const managed = new ManagedBuyer(
    (home, relayToken) =>
      utilityProcess.fork(join(directory, DESKTOP_X402.SERVICE_FILE), [], {
        cwd: home,
        stdio: 'ignore',
        env: buyerEnvironment(home, relayToken, process.env),
      }),
    () => client.disconnect(),
  );
  return {
    close: () => managed.close(),
    selected: () => selectedHome !== null,
    async choose() {
      const chosen = await dialog.showOpenDialog(window, {
        title: 'Choose GYBLOS_HOME containing the buyer configuration',
        properties: ['openDirectory'],
      });
      const path = chosen.filePaths[0];
      if (!chosen.canceled && path && isAbsolute(path)) selectedHome = path;
    },
    async start(input: unknown) {
      const relayToken =
        typeof input === 'string' && input
          ? input
          : process.env.GYBLOS_RELAY_TOKEN;
      if (
        !selectedHome ||
        typeof relayToken !== 'string' ||
        !relayToken ||
        relayToken.length > DESKTOP_X402.MAX_RELAY_TOKEN ||
        /[\r\n]/.test(relayToken)
      )
        throw new Error(
          'Choose buyer configuration and provide the relay token',
        );
      const connection = await managed.start(selectedHome, relayToken);
      try {
        await client.connect(connection.url, connection.token);
      } catch {
        await managed.stop();
        throw new Error('Local buyer is unavailable');
      }
    },
  };
}
export function registerDesktopX402(
  window: BrowserWindow,
  profile: string,
  directory: string,
) {
  const paths = desktopX402Paths(profile);
  let ownership: Promise<ProcessLock> | null = null;
  const budget = new X402Budget({
    async read() {
      ownership ??= acquireProcessLock(paths.lock);
      await ownership;
      return readPrivateFile(paths.state, DESKTOP_X402.MAX_BYTES);
    },
    async write(text) {
      const lock = await ownership;
      if (!lock) throw new Error('Storage unavailable');
      await lock.verify();
      await writePrivateFile(paths.state, text, DESKTOP_X402.MAX_BYTES);
    },
  });
  const client = new X402Client(budget);
  const managed = managedBuyer(window, directory, client);
  const handle = createX402Handlers(
    client,
    budget,
    {
      contents: window.webContents,
      mainFrame: () => window.webContents.mainFrame,
      destroyed: () => window.isDestroyed(),
    },
    (url) => shell.openExternal(url),
    managed,
    (value) => clipboard.writeText(value),
  );
  const apiKeys = createUsdcApiHandlers(
    client,
    {
      contents: window.webContents,
      mainFrame: () => window.webContents.mainFrame,
      destroyed: () => window.isDestroyed(),
    },
    (text) => clipboard.writeText(text),
    { home: homedir(), environment: process.env },
  );
  ipcMain.handle(USDC_API.CHANNEL, (event, ...args: unknown[]) =>
    apiKeys.run(event, args),
  );
  ipcMain.handle(DESKTOP_X402.CHANNEL, (event, ...args: unknown[]) =>
    handle(event, args),
  );
  return {
    async close() {
      apiKeys.close();
      ipcMain.removeHandler(USDC_API.CHANNEL);
      await client.close();
      await managed.close();
      ipcMain.removeHandler(DESKTOP_X402.CHANNEL);
      await (await ownership?.catch(() => null))?.release();
    },
  };
}
