// Runs the isolated desktop compatibility window, not a buyer or seller daemon.
// Only bundled assets and one read-only loopback probe are reachable from the UI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { DESKTOP, PROBE_STATUS } from './constants.js';
import { probeInUtility } from './probe-host.js';
import { failedProbe, type ProbeResult } from './probe-model.js';
import { armSmokeWatchdog } from './smoke-watchdog.js';

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

async function main() {
  const smoke = process.argv.includes(DESKTOP.SMOKE_FLAG);
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
  app.setPath('userData', home);
  app.setPath('sessionData', home);
  app.on('quit', () => rmSync(home, { recursive: true, force: true }));
  await app.whenReady();
  const window = createProbeWindow(smoke);
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
  await window.loadFile(join(__dirname, 'renderer', 'index.html'));
}
void main().catch(() => {
  process.stderr.write('Desktop probe startup failed.\n');
  app.exit(1);
});
