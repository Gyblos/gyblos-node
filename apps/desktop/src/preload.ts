// Exposes fixed probe, public wallet status/copy and bounded setup/backup interactions; no signing or raw IPC.
import { contextBridge, ipcRenderer } from 'electron';

import { NETWORK_CATALOG, parseNetworkCatalog } from './catalog/model';
import { DESKTOP } from './constants';
import { LOCAL_NODE, parseLocalNodeState } from './node-status';
import { parseProbeResult } from './probe-model';
import { BACKUP_FLOW, parseBackupResult } from './wallet/backup-flow-model';
import { parseWalletSummary, WALLET } from './wallet/model';
import {
  parseWalletCollection,
  parseWalletSettingsResult,
  WALLET_SETTINGS,
} from './wallet/settings-model';

contextBridge.exposeInMainWorld('desktopCatalog', {
  summary: async () =>
    parseNetworkCatalog(
      await ipcRenderer.invoke(NETWORK_CATALOG.STATUS_CHANNEL),
    ),
  lookup: async (model: unknown) =>
    parseNetworkCatalog(
      await ipcRenderer.invoke(NETWORK_CATALOG.LOOKUP_CHANNEL, model),
    ),
});

contextBridge.exposeInMainWorld('desktopNode', {
  summary: async () =>
    parseLocalNodeState(await ipcRenderer.invoke(LOCAL_NODE.STATUS_CHANNEL)),
  retry: async () =>
    parseLocalNodeState(await ipcRenderer.invoke(LOCAL_NODE.RETRY_CHANNEL)),
});

contextBridge.exposeInMainWorld('desktopProbe', {
  run: async () => parseProbeResult(await ipcRenderer.invoke(DESKTOP.CHANNEL)),
});
contextBridge.exposeInMainWorld('desktopWallet', {
  collection: async () =>
    parseWalletCollection(
      await ipcRenderer.invoke(WALLET_SETTINGS.COLLECTION_CHANNEL),
    ),
  manage: async (request: unknown) =>
    parseWalletSettingsResult(
      await ipcRenderer.invoke(WALLET_SETTINGS.CHANNEL, request),
    ),
  copyAddress: async (address: unknown) =>
    (await ipcRenderer.invoke(WALLET.COPY_CHANNEL, address)) === true,
  backup: async (request: unknown) =>
    parseBackupResult(await ipcRenderer.invoke(BACKUP_FLOW.CHANNEL, request)),
  summary: async () =>
    parseWalletSummary(await ipcRenderer.invoke(WALLET.CHANNEL)),
});
