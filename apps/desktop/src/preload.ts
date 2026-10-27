// Exposes fixed probe, public wallet status/copy and bounded setup/backup interactions; no signing or raw IPC.
import { contextBridge, ipcRenderer } from 'electron';

import { DESKTOP } from './constants.js';
import { parseProbeResult } from './probe-model.js';
import { BACKUP_FLOW, parseBackupResult } from './wallet/backup-flow-model.js';
import { parseWalletSummary, WALLET } from './wallet/model.js';
import { parseSetupView, WALLET_SETUP } from './wallet/setup-model.js';

contextBridge.exposeInMainWorld('desktopProbe', {
  run: async () => parseProbeResult(await ipcRenderer.invoke(DESKTOP.CHANNEL)),
});
contextBridge.exposeInMainWorld('desktopWallet', {
  copyAddress: async (address: unknown) =>
    (await ipcRenderer.invoke(WALLET.COPY_CHANNEL, address)) === true,
  backup: async (request: unknown) =>
    parseBackupResult(await ipcRenderer.invoke(BACKUP_FLOW.CHANNEL, request)),
  summary: async () =>
    parseWalletSummary(await ipcRenderer.invoke(WALLET.CHANNEL)),
});

contextBridge.exposeInMainWorld('desktopWalletSetup', {
  run: async (request: unknown) =>
    parseSetupView(await ipcRenderer.invoke(WALLET_SETUP.CHANNEL, request)),
});
