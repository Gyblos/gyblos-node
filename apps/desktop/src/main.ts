// Hosts simulated inference and a local protected wallet; never starts paid services.
// The renderer receives public metadata only; smoke never creates a wallet.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { DESKTOP, PROBE_STATUS, STARTUP_WINDOW } from './constants.js';
import { probeInUtility } from './probe-host.js';
import { failedProbe, type ProbeResult } from './probe-model.js';
import { cleanupDesktopSession } from './session-cleanup.js';
import { armSmokeWatchdog } from './smoke-watchdog.js';
import { startupHandoff } from './startup-window.js';
import { BRAND_COLORS } from './theme.js';
import { WALLET } from './wallet/constants.js';
import { registerDesktopWallet } from './wallet/host.js';
import {
  focusExistingWindow,
  prepareWalletProfile,
} from './wallet/lifecycle.js';

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
  const prepared = registerDesktopWallet(
    window,
    walletRoot,
    smoke,
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
