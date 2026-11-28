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

import { desktopX402Paths } from '@gyblos/config/home-desktop';
import { reviewDesktopCharge } from '@gyblos/node/buyer-funding';
import { desktopOpening } from '@gyblos/node/desktop-opening';
import { BUYER_SIDECAR } from '@gyblos/protocol/buyer-api';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import { registerFunding } from './funding/host';
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
  const fork = (args: string[]) =>
    utilityProcess.fork(join(directory, DESKTOP_X402.SERVICE_FILE), args, {
      cwd: profile,
      stdio: 'ignore',
      env: environment,
    });
  const service = new ManagedBuyer(
    (_home, _token, maxAtomic, autoPrices) =>
      fork(
        maxAtomic === undefined
          ? []
          : [
              maxAtomic,
              ...(autoPrices === undefined ? [] : [JSON.stringify(autoPrices)]),
            ],
      ),
    () => client.disconnect(),
  );
  const managed = automaticBuyer(
    {
      start: (maxAtomic, autoPrices) =>
        service.start(profile, undefined, maxAtomic, autoPrices),
      stop: () => service.stop(),
      stopWhenIdle: () =>
        service.stopWhenIdle(() => {
          if (!client.policy()) void managed.start().catch(() => {});
        }),
      setRenewalBudget: (amount) =>
        new Promise<void>((resolve, reject) => {
          const writer = fork([
            BUYER_SIDECAR.SET_RENEWAL,
            JSON.stringify(amount),
          ]);
          const timeout = setTimeout(
            () => writer.kill(),
            DESKTOP_X402.START_MS,
          );
          writer.once('exit', (code) => {
            clearTimeout(timeout);
            if (code === 0) resolve();
            else
              reject(new Error('Could not save the channel renewal budget.'));
          });
        }),
      close: () => service.close(),
    },
    client,
    budget,
  );
  return { environment, managed };
}
function frameOwner(window: BrowserWindow) {
  return {
    contents: window.webContents,
    mainFrame: () => window.webContents.mainFrame,
    destroyed: () => window.isDestroyed(),
  };
}
function ownedBudget(profile: string) {
  const paths = desktopX402Paths(profile);
  let ownership: Promise<ProcessLock> | null = null;
  const budget = new X402Budget(
    {
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
    },
    desktopOpening({ GYBLOS_HOME: profile }),
  );
  return {
    budget,
    release: async () => (await ownership?.catch(() => null))?.release(),
  };
}
export function registerDesktopX402(
  window: BrowserWindow,
  profile: string,
  directory: string,
  resolveOffer: ReturnType<
    typeof import('./catalog/host').registerNetworkCatalog
  >,
) {
  const { budget, release } = ownedBudget(profile);
  const client = new X402Client(budget);
  const { environment, managed } = managedBuyer(
    profile,
    directory,
    client,
    budget,
  );
  const closeFunding = registerFunding(
    window,
    environment,
    () => client.policy(),
    () => client.managed(),
    (seller) => client.inspectChannel(seller),
    resolveOffer.resolve,
  );
  const owner = frameOwner(window);
  const handle = createX402Handlers(
    client,
    budget,
    owner,
    (url) => shell.openExternal(url),
    {
      ...managed,
      review: (ref, policy, signal) =>
        reviewDesktopCharge(environment, ref, policy, signal),
    },
    (value) => clipboard.writeText(value),
    (progress) =>
      window.webContents.mainFrame.send(
        DESKTOP_X402.PROGRESS_CHANNEL,
        progress,
      ),
    resolveOffer.current,
  );
  const apiKeys = createUsdcApiHandlers(
    client,
    owner,
    (text) => clipboard.writeText(text),
    { home: homedir(), environment },
  );
  ipcMain.handle(USDC_API.CHANNEL, (event, ...args: unknown[]) =>
    apiKeys.run(event, args),
  );
  ipcMain.handle(USDC_API.REVEAL_CHANNEL, (event, ...args: unknown[]) =>
    apiKeys.reveal(event, args),
  );
  ipcMain.handle(DESKTOP_X402.CHANNEL, (event, ...args: unknown[]) =>
    handle(event, args),
  );
  return {
    async close() {
      closeFunding();
      apiKeys.close();
      ipcMain.removeHandler(USDC_API.CHANNEL);
      ipcMain.removeHandler(USDC_API.REVEAL_CHANNEL);
      await client.close();
      await managed.close();
      ipcMain.removeHandler(DESKTOP_X402.CHANNEL);
      await release();
    },
  };
}
