// Main-frame bridge and private budget storage; the buyer runs as an isolated executable.
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  app,
  clipboard,
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
import { automaticBuyer } from './x402-startup';

function managedBuyer(
  profile: string,
  directory: string,
  client: X402Client,
  budget: X402Budget,
) {
  const environment = buyerEnvironment(
    profile,
    process.env.GYBLOS_RELAY_TOKEN || undefined,
    process.env,
    // Packaged releases upload receipts to the metrics collector; development runs do not.
    app.isPackaged ? app.getVersion() : undefined,
  );
  const service = new ManagedBuyer(
    () =>
      utilityProcess.fork(join(directory, DESKTOP_X402.SERVICE_FILE), [], {
        cwd: profile,
        stdio: 'ignore',
        env: environment,
      }),
    () => client.disconnect(),
  );
  const managed = automaticBuyer(
    {
      start: () => service.start(profile),
      stop: () => service.stop(),
      close: () => service.close(),
    },
    client,
    budget,
  );
  return { environment, managed };
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
  const { environment, managed } = managedBuyer(
    profile,
    directory,
    client,
    budget,
  );
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
    { home: homedir(), environment },
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
