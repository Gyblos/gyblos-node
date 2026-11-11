// Hosts the local protected wallet and an opt-in PayPal Sandbox inference service.
// The renderer receives public metadata only; smoke never creates a wallet or PayPal service.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { registerNetworkCatalog } from './catalog/host';
import { registerChatArchive } from './chat-archive-host';
import { DESKTOP, PROBE_STATUS, STARTUP_WINDOW } from './constants';
import { registerDesktopNode } from './node-host';
import { createDesktopQuitCoordinator } from './paypal-close-guard';
import { registerDesktopPaypal } from './paypal-host';
import { probeInUtility } from './probe-host';
import { failedProbe, type ProbeResult } from './probe-model';
import { cleanupDesktopSession } from './session-cleanup';
import { armSmokeWatchdog } from './smoke-watchdog';
import { settleDesktopStartup, startupHandoff } from './startup-window';
import { BRAND_COLORS } from './theme';
import { WALLET } from './wallet/constants';
import { registerDesktopWallet } from './wallet/host';
import { focusExistingWindow, prepareWalletProfile } from './wallet/lifecycle';
import { windowChrome } from './window-chrome';
import { registerDesktopX402 } from './x402-host';

function createProbeWindow(startup = false) {
  const window = new BrowserWindow({
    ...windowChrome(process.platform, startup),
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

type DesktopServices = {
  wallet: ReturnType<typeof registerDesktopWallet> | undefined;
  node: ReturnType<typeof registerDesktopNode> | null;
  paypal: ReturnType<typeof registerDesktopPaypal> | null;
  chats: ReturnType<typeof registerChatArchive> | null;
  x402: ReturnType<typeof registerDesktopX402> | null;
};
function createDesktopServices(): DesktopServices {
  return {
    wallet: undefined,
    node: null,
    paypal: null,
    chats: null,
    x402: null,
  };
}
function installDesktopServices(
  services: DesktopServices,
  window: BrowserWindow,
  walletRoot: string,
  smoke: boolean,
  signal: AbortSignal,
) {
  const wallet = registerDesktopWallet(window, walletRoot, smoke, signal);
  services.wallet = wallet;
  if (!smoke) {
    registerNetworkCatalog(window, signal);
    services.paypal = registerDesktopPaypal(window);
    services.chats = registerChatArchive(window, app.getPath('userData'));
    services.x402 = registerDesktopX402(
      window,
      app.getPath('userData'),
      __dirname,
    );
    services.node = registerDesktopNode(window, __dirname, signal);
  }
  return wallet.ready;
}

function registerDesktopQuit(
  controller: AbortController,
  services: () => DesktopServices,
) {
  app.on(
    'before-quit',
    createDesktopQuitCoordinator(
      (event) => services().paypal?.guard(event) ?? false,
      async () => {
        controller.abort();
        const { wallet, node, paypal, chats, x402 } = services();
        await Promise.allSettled([
          wallet?.settled() ?? Promise.resolve(),
          node?.close() ?? Promise.resolve(),
          paypal?.close() ?? Promise.resolve(),
          chats?.close() ?? Promise.resolve(),
          x402?.close() ?? Promise.resolve(),
        ]);
      },
      () => app.quit(),
    ),
  );
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
  const services = createDesktopServices();
  const fail = () => {
    process.stdout.write(`${JSON.stringify(failedProbe())}\n`);
    app.exit(1);
  };
  const cancelWatchdog = smoke ? armSmokeWatchdog(fail) : () => {};
  registerDesktopQuit(controller, () => services);
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
  const preparation = installDesktopServices(
    services,
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
  await settleDesktopStartup(
    loadDesktopWindows(window, loading, preparation, controller.signal),
    () => services.node?.close() ?? Promise.resolve(),
  );
}
void main().catch(() => {
  process.stderr.write('Desktop probe startup failed.\n');
  app.exit(1);
});
