// Hosts simulated inference and a local protected wallet; never starts paid services.
// The renderer receives public metadata only; smoke never creates a wallet.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';

import { DESKTOP, PROBE_STATUS } from './constants.js';
import { probeInUtility } from './probe-host.js';
import { failedProbe, type ProbeResult } from './probe-model.js';
import { armSmokeWatchdog } from './smoke-watchdog.js';
import { WALLET, WALLET_STATUS } from './wallet/constants.js';
import {
  prepareWalletProfile,
  waitForWalletBeforeQuit,
} from './wallet/lifecycle.js';
import { walletSummary } from './wallet/model.js';
import { walletProtection } from './wallet/protection.js';
import { createWalletService } from './wallet/service.js';

function createProbeWindow(smoke: boolean) {
  const window = new BrowserWindow({
    title: DESKTOP.TITLE,
    width: DESKTOP.WIDTH,
    height: DESKTOP.HEIGHT,
    minWidth: DESKTOP.MIN_WIDTH,
    minHeight: DESKTOP.MIN_HEIGHT,
    show: !smoke,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  return window;
}

function registerWalletStatus(
  window: BrowserWindow,
  walletRoot: string,
  smoke: boolean,
) {
  const summary = smoke
    ? Promise.resolve(walletSummary(WALLET_STATUS.UNAVAILABLE))
    : createWalletService(
        walletRoot,
        walletProtection(process.platform, safeStorage),
      ).summary();
  if (!smoke)
    app.on(
      'before-quit',
      waitForWalletBeforeQuit(summary, () => app.quit()),
    );
  ipcMain.handle(WALLET.CHANNEL, (event, ...args: unknown[]) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      args.length !== 0
    )
      throw new Error('Unsupported wallet status sender.');
    return summary;
  });
}

async function main() {
  const smoke = process.argv.includes(DESKTOP.SMOKE_FLAG);
  app.setName(WALLET.APP_NAME);
  const walletRoot = join(app.getPath('appData'), WALLET.ROOT);
  if (!smoke) {
    const profile = join(app.getPath('appData'), WALLET.PROFILE);
    prepareWalletProfile(profile);
    app.setPath('userData', profile);
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
  }
  const controller = new AbortController();
  const fail = () => {
    process.stdout.write(`${JSON.stringify(failedProbe())}\n`);
    app.exit(1);
  };
  const cancelWatchdog = smoke ? armSmokeWatchdog(fail) : () => {};
  app.on('quit', () => {
    cancelWatchdog();
    controller.abort();
  });
  const home = mkdtempSync(join(tmpdir(), 'gyblos-desktop-probe-'));
  if (smoke) app.setPath('userData', home);
  app.setPath('sessionData', home);
  app.on('quit', () => rmSync(home, { recursive: true, force: true }));
  await app.whenReady();
  app.dock?.setIcon(join(__dirname, 'renderer', DESKTOP.ICON_FILE));
  const window = createProbeWindow(smoke);
  registerWalletStatus(window, walletRoot, smoke);
  app.on('second-instance', () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  if (smoke) window.webContents.on('render-process-gone', fail);
  let pending: Promise<ProbeResult> | undefined;
  ipcMain.handle(DESKTOP.CHANNEL, (event) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('Unsupported probe sender.');
    pending ??= probeInUtility(__dirname, controller.signal);
    if (smoke) {
      return pending.then((result) => {
        cancelWatchdog();
        process.stdout.write(`${JSON.stringify(result)}\n`);
        setTimeout(() => {
          app.exit(result.status === PROBE_STATUS.PASSED ? 0 : 1);
        }, DESKTOP.EXIT_DELAY_MS);
        return result;
      });
    }
    return pending;
  });
  window.on('closed', () => {
    controller.abort();
    app.quit();
  });
  await window.loadFile(join(__dirname, 'renderer', 'index.html'), {
    query: smoke ? { probe: '1' } : {},
  });
}
void main().catch(() => {
  process.stderr.write('Desktop probe startup failed.\n');
  app.exit(1);
});
