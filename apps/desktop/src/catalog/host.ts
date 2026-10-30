// Hosts anonymous read-only discovery in an ephemeral session; renderer networking stays denied.
import { ipcMain, session, type BrowserWindow } from 'electron';

import { DISCOVERY_INDEX_URL } from '@gyblos/config';

import { NETWORK_CATALOG } from './constants';
import { createCatalogHandlers } from './handlers';
import { createCatalogSession } from './session';

export function registerNetworkCatalog(
  window: BrowserWindow,
  signal: AbortSignal,
) {
  const isolated = session.fromPartition(NETWORK_CATALOG.PARTITION, {
    cache: false,
  });
  const endpoint = new URL(`${DISCOVERY_INDEX_URL}/sellers`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const target = new URL(details.url);
      callback({
        cancel:
          target.origin !== endpoint.origin ||
          target.pathname !== endpoint.pathname,
      });
    },
  );
  const catalog = createCatalogSession(
    (url, init) =>
      isolated.fetch(url, { ...init, credentials: 'omit', cache: 'no-store' }),
    Date.now,
    signal,
  );
  const handlers = createCatalogHandlers(catalog, {
    contents: window.webContents,
    mainFrame: () => window.webContents.mainFrame,
    destroyed: () => window.isDestroyed(),
  });
  ipcMain.handle(NETWORK_CATALOG.STATUS_CHANNEL, (event, ...args: unknown[]) =>
    handlers.summary(event, args),
  );
  ipcMain.handle(NETWORK_CATALOG.LOOKUP_CHANNEL, (event, ...args: unknown[]) =>
    handlers.lookup(event, args),
  );
}
