// Hosts anonymous read-only discovery in an ephemeral session; renderer networking stays denied.
import { ipcMain, session, type BrowserWindow } from 'electron';

import { DISCOVERY_INDEX_URL } from '@gyblos/config';

import { NETWORK_CATALOG } from './constants';
import { registerCatalogHandlers } from './handlers';
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
          (target.pathname !== endpoint.pathname &&
            target.pathname !==
              endpoint.pathname.replace(/sellers$/, 'models')),
      });
    },
  );
  const createSession = () =>
    createCatalogSession(
      (url, init) =>
        isolated.fetch(url, {
          ...init,
          credentials: 'omit',
          cache: 'no-store',
        }),
      Date.now,
      signal,
      (record) => console.error(JSON.stringify(record)),
    );
  const catalog = createSession();
  const search = createSession();
  registerCatalogHandlers(
    (channel, handler) => ipcMain.handle(channel, handler),
    { summary: catalog.browse, lookup: search.lookup },
    {
      contents: window.webContents,
      mainFrame: () => window.webContents.mainFrame,
      destroyed: () => window.isDestroyed(),
    },
  );
  const resolve = (offerId: string) =>
    catalog.resolve(offerId) ?? search.resolve(offerId);
  return {
    resolve,
    async current(offerId: string) {
      const found = resolve(offerId);
      if (found) return found;
      await catalog.browse();
      return resolve(offerId);
    },
  };
}
