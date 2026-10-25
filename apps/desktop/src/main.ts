// Hosts simulated inference and a local protected wallet; never starts paid services.
// The renderer receives public metadata only; smoke never creates a wallet.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';

import { DESKTOP, PROBE_STATUS, STARTUP_WINDOW } from './constants.js';
import { probeInUtility } from './probe-host.js';
import { failedProbe, type ProbeResult } from './probe-model.js';
import { cleanupDesktopSession } from './session-cleanup.js';
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
import { walletSummary, type WalletSummary } from './wallet/model.js';
import {
  walletProtection,
  type WalletProtection,
} from './wallet/protection.js';
import { createWalletService } from './wallet/service.js';
import { SETUP_STATUS, WALLET_SETUP } from './wallet/setup-model.js';
import { createWalletSetup } from './wallet/setup.js';

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

function registerWalletSetup(
  loading: BrowserWindow | null,
  walletRoot: string,
  protection: WalletProtection | null,
  signal: AbortSignal,
) {
  if (!loading) return null;
  const setup = createWalletSetup(
    walletRoot,
    protection,
    {
      async select() {
        const result = await dialog.showOpenDialog(loading, {
          title: 'Restore encrypted wallet backup',
          properties: ['openFile'],
          filters: [{ name: 'Gyblos encrypted backup', extensions: ['json'] }],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    },
    signal,
  );
  ipcMain.handle(WALLET_SETUP.CHANNEL, async (event, ...args: unknown[]) => {
    if (
      !loading ||
      !setup ||
      event.sender !== loading.webContents ||
      event.senderFrame !== loading.webContents.mainFrame ||
      args.length !== 1
    )
      throw new Error('Unsupported wallet setup sender.');
    const result = await setup.run(args[0]);
    if (!loading.isDestroyed() && result.status !== SETUP_STATUS.COMPLETE)
      loading.setSize(STARTUP_WINDOW.WIDTH, STARTUP_WINDOW.SETUP_HEIGHT);
    return result;
  });
  return setup;
}

function registerWalletBackup(
  window: BrowserWindow,
  summary: Promise<WalletSummary>,
  backup: ReturnType<typeof createBackupFlow>,
  signal: AbortSignal,
  smoke: boolean,
) {
  ipcMain.handle(BACKUP_FLOW.CHANNEL, async (event, ...args: unknown[]) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      args.length !== 1
    )
      throw new Error('Unsupported wallet backup sender.');
    const ready = await summary;
    return !smoke && !signal.aborted && ready.status === WALLET_STATUS.READY
      ? backup.run(args[0])
      : BACKUP_RESULT.FAILED;
  });
}

function registerWalletStatus(
  window: BrowserWindow,
  walletRoot: string,
  smoke: boolean,
  loading: BrowserWindow | null,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const protection = smoke
    ? null
    : walletProtection(process.platform, safeStorage);
  const setup = registerWalletSetup(loading, walletRoot, protection, signal);
  const summary =
    setup?.summary ?? Promise.resolve(walletSummary(WALLET_STATUS.UNAVAILABLE));
  const wallet = createWalletService(walletRoot, protection, summary);
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
          return summary
            .then(() => setup?.settled())
            .then(() => backup.settled());
        },
        () => app.quit(),
      ),
    );
  registerWalletBackup(window, summary, backup, controller.signal, smoke);
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
  signal: AbortSignal,
) {
  const file = join(__dirname, 'renderer', 'index.html');
  if (!loading) {
    await window.loadFile(file, { query: { probe: '1' } });
    return;
  }
  const handoff = startupHandoff(window, loading, signal);
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
  // Stop window reveals immediately; wallet/backup settlement still owns quit.
  app.once('before-quit', () => controller.abort());
  app.on('quit', () => {
    cancelWatchdog();
    controller.abort();
  });
  const home = mkdtempSync(join(tmpdir(), 'gyblos-desktop-probe-'));
  if (smoke) app.setPath('userData', home);
  app.setPath('sessionData', home);
  app.on('quit', () =>
    cleanupDesktopSession(home, () => {
      process.stderr.write('Temporary desktop session cleanup failed.\n');
    }),
  );
  await app.whenReady();
  app.dock?.setIcon(join(__dirname, 'renderer', DESKTOP.ICON_FILE));
  const window = createProbeWindow();
  const loading = smoke ? null : createProbeWindow(true);
  const prepared = registerWalletStatus(
    window,
    walletRoot,
    smoke,
    loading,
    controller.signal,
  );
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
  await loadDesktopWindows(window, loading, prepared, controller.signal);
}
void main().catch(() => {
  process.stderr.write('Desktop probe startup failed.\n');
  app.exit(1);
});
