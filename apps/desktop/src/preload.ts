// Exposes fixed probe, public wallet status/copy and bounded setup/backup interactions; no signing or raw IPC.
import { contextBridge, ipcRenderer } from 'electron';

import { parseActivityResult } from './activity-model';
import { NETWORK_CATALOG, parseNetworkCatalog } from './catalog/model';
import {
  parseChatArchiveLoad,
  parseChatArchiveStatus,
} from './chat-archive-model';
import { CHAT_STORAGE, DESKTOP, DESKTOP_ACTIVITY } from './constants';
import { LOCAL_NODE, parseLocalNodeState } from './node-status';
import { parsePaymentReferences } from './payment-reference-model';
import {
  DESKTOP_PAYPAL_AGENT,
  parsePaypalAgentResult,
} from './paypal-agent-model';
import { DESKTOP_PAYPAL, parsePaypalResult } from './paypal-model';
import { parseProbeResult } from './probe-model';
import { BACKUP_FLOW, parseBackupResult } from './wallet/backup-flow-model';
import { parseWalletSummary, WALLET } from './wallet/model';
import {
  parseWalletCollection,
  parseWalletSettingsResult,
  WALLET_SETTINGS,
} from './wallet/settings-model';

contextBridge.exposeInMainWorld('desktopConversations', {
  load: async () =>
    parseChatArchiveLoad(await ipcRenderer.invoke(CHAT_STORAGE.LOAD_CHANNEL)),
  save: async (request: unknown) =>
    parseChatArchiveStatus(
      await ipcRenderer.invoke(CHAT_STORAGE.SAVE_CHANNEL, request),
    ),
  status: async () =>
    parseChatArchiveStatus(
      await ipcRenderer.invoke(CHAT_STORAGE.STATUS_CHANNEL),
    ),
});

contextBridge.exposeInMainWorld('desktopActivity', {
  copyReference: async (sessionId: string) =>
    (await ipcRenderer.invoke(
      DESKTOP_ACTIVITY.COPY_REFERENCE_CHANNEL,
      sessionId,
    )) === true,
  references: async () =>
    parsePaymentReferences(
      await ipcRenderer.invoke(DESKTOP_ACTIVITY.REFERENCES_CHANNEL),
    ),
  summary: async () =>
    parseActivityResult(await ipcRenderer.invoke(DESKTOP_ACTIVITY.CHANNEL)),
});

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

contextBridge.exposeInMainWorld('desktopPaypal', {
  run: async (request: unknown) =>
    parsePaypalResult(
      await ipcRenderer.invoke(DESKTOP_PAYPAL.CHANNEL, request),
    ),
  onReturn: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(DESKTOP_PAYPAL.RETURN_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(DESKTOP_PAYPAL.RETURN_CHANNEL, handler);
    };
  },
  onCancel: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(DESKTOP_PAYPAL.CANCEL_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(DESKTOP_PAYPAL.CANCEL_CHANNEL, handler);
    };
  },
});

contextBridge.exposeInMainWorld('desktopPaypalAgent', {
  run: async (request: unknown) =>
    parsePaypalAgentResult(
      await ipcRenderer.invoke(DESKTOP_PAYPAL_AGENT.CHANNEL, request),
    ),
  copy: async (request: unknown) =>
    (await ipcRenderer.invoke(DESKTOP_PAYPAL_AGENT.COPY_CHANNEL, request)) ===
    true,
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
