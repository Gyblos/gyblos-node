// Hosts simulated inference and a local protected wallet; never starts paid services.
// The renderer receives public metadata only; smoke never creates a wallet.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';

import { DESKTOP, PROBE_STATUS, STARTUP_WINDOW } from './constants.js';
import { probeInUtility } from './probe-host.js';
import { failedProbe, type ProbeResult } from './probe-model.js';
import { armSmokeWatchdog } from './smoke-watchdog.js';
import { startupHandoff } from './startup-window.js';
import { BRAND_COLORS } from './theme.js';
import { BACKUP_FLOW, BACKUP_RESULT } from './wallet/backup-flow-model.js';
import { createBackupFlow } from './wallet/backup-flow.js';
import { WALLET, WALLET_STATUS } from './wallet/constants.js';
import {
  focusExistingWindow,
  prepareWalletProfile,
  waitForWalletBeforeQuit,
} from './wallet/lifecycle.js';
import { walletSummary } from './wallet/model.js';
import { walletProtection } from './wallet/protection.js';
import { createWalletService } from './wallet/service.js';

function createProbeWindow(startup = false) {
  const window = new BrowserWindow({
    title: DESKTOP.TITLE,
    width: startup ? STARTUP_WINDOW.WIDTH : DESKTOP.WIDTH,
    height: startup ? STARTUP_WINDOW.HEIGHT : DESKTOP.HEIGHT,
    minWidth: startup ? STARTUP_WINDOW.WIDTH : DESKTOP.MIN_WIDTH,
    minHeight: startup ? STARTUP_WINDOW.HEIGHT : DESKTOP.MIN_HEIGHT,
    show: false,
    resizable: !startup,
    backgroundColor: BRAND_COLORS.charcoal,
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
  const controller = new AbortController();
  const wallet = createWalletService(
    walletRoot,
    smoke ? null : walletProtection(process.platform, safeStorage),
  );
  const summary = smoke
    ? Promise.resolve(walletSummary(WALLET_STATUS.UNAVAILABLE))
    : wallet.summary();
  const backup = createBackupFlow(
    wallet,
    {
      async approve() {
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          title: 'Wallet backup',
          message: 'Allow this wallet backup operation?',
          detail:
            'Your password protects the file. Gyblos cannot recover a lost file or password. Funding stays disabled.',
          buttons: ['Cancel', 'Continue'],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      },
      async save() {
        const result = await dialog.showSaveDialog(window, {
          title: 'Save encrypted wallet backup',
          defaultPath: BACKUP_FLOW.FILENAME,
          filters: [{ name: 'Gyblos encrypted backup', extensions: ['json'] }],
        });
        return result.canceled ? null : (result.filePath ?? null);
      },
      async select() {
        const result = await dialog.showOpenDialog(window, {
          title: 'Choose the saved wallet backup',
          properties: ['openFile'],
          filters: [{ name: 'Gyblos encrypted backup', extensions: ['json'] }],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    },
    controller.signal,
  );
  window.once('closed', () => controller.abort());
  if (!smoke)
    app.on(
      'before-quit',
      waitForWalletBeforeQuit(
        () => {
          controller.abort();
          return summary.then(() => backup.settled());
        },
        () => app.quit(),
      ),
    );
  ipcMain.handle(BACKUP_FLOW.CHANNEL, (event, ...args: unknown[]) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      args.length !== 1
    )
      throw new Error('Unsupported wallet backup sender.');
    return smoke ? BACKUP_RESULT.FAILED : backup.run(args[0]);
  });
  ipcMain.handle(WALLET.CHANNEL, (event, ...args: unknown[]) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      args.length !== 0
    )
      throw new Error('Unsupported wallet status sender.');
    return summary;
  });
  return summary;
}

async function loadDesktopWindows(
  window: BrowserWindow,
  loading: BrowserWindow | null,
  preparation: Promise<unknown>,
) {
  const file = join(__dirname, 'renderer', 'index.html');
  if (!loading) {
    await window.loadFile(file, { query: { probe: '1' } });
    return;
  }
  const handoff = startupHandoff(window, loading);
  // Storage errors are displayed by the main wallet UI, never by the splash.
  const settled = preparation.then(
    () => handoff.prepared(),
    () => handoff.prepared(),
  );
  try {
    await loading.loadFile(file, {
      query: { [STARTUP_WINDOW.QUERY]: STARTUP_WINDOW.QUERY_VALUE },
    });
    if (handoff.cancelled()) return;
    await window.loadFile(file);
    await settled;
  } catch (error) {
    if (handoff.cancelled()) return;
    if (!loading.isDestroyed()) loading.destroy();
    await settled;
    throw error;
  }
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
  const window = createProbeWindow();
  const prepared = registerWalletStatus(window, walletRoot, smoke);
  const loading = smoke ? null : createProbeWindow(true);
  app.on('second-instance', () => {
    focusExistingWindow(loading && !loading.isDestroyed() ? loading : window);
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
  await loadDesktopWindows(window, loading, prepared);
}
void main().catch(() => {
  process.stderr.write('Desktop probe startup failed.\n');
  app.exit(1);
});
