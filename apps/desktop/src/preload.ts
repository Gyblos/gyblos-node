// Exposes fixed probe and public wallet status; no raw IPC, signing or secret API.
import { contextBridge, ipcRenderer } from 'electron';

import { DESKTOP } from './constants.js';
import { parseProbeResult } from './probe-model.js';
import { parseWalletSummary, WALLET } from './wallet/model.js';

contextBridge.exposeInMainWorld('desktopProbe', {
  run: async () => parseProbeResult(await ipcRenderer.invoke(DESKTOP.CHANNEL)),
});
contextBridge.exposeInMainWorld('desktopWallet', {
  summary: async () =>
    parseWalletSummary(await ipcRenderer.invoke(WALLET.CHANNEL)),
});
