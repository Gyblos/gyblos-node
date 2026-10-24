// Exposes fixed probe, public wallet status and bounded backup interactions; no signing or raw IPC.
import { contextBridge, ipcRenderer } from 'electron';

import { DESKTOP } from './constants.js';
import { parseProbeResult } from './probe-model.js';
import { BACKUP_FLOW, parseBackupResult } from './wallet/backup-flow-model.js';
import { parseWalletSummary, WALLET } from './wallet/model.js';

contextBridge.exposeInMainWorld('desktopProbe', {
  run: async () => parseProbeResult(await ipcRenderer.invoke(DESKTOP.CHANNEL)),
});
contextBridge.exposeInMainWorld('desktopWallet', {
  backup: async (request: unknown) =>
    parseBackupResult(await ipcRenderer.invoke(BACKUP_FLOW.CHANNEL, request)),
  summary: async () =>
    parseWalletSummary(await ipcRenderer.invoke(WALLET.CHANNEL)),
});
