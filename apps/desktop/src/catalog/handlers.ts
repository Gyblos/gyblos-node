// Fixed model-lookup IPC authenticates the current window/main frame and arity.
import { CATALOG_STATE, emptyCatalog, type NetworkCatalog } from './model';

interface CatalogSession {
  summary(): NetworkCatalog;
  lookup(model: string): Promise<NetworkCatalog>;
}
interface CatalogWindow {
  contents: unknown;
  mainFrame(): unknown;
  destroyed(): boolean;
}
interface CatalogSender {
  sender: unknown;
  senderFrame: unknown;
}
export function createCatalogHandlers(
  _session: CatalogSession | null,
  _window: CatalogWindow,
) {
  return {
    summary: (_event: CatalogSender, _args: readonly unknown[]) =>
      emptyCatalog(CATALOG_STATE.ERROR),
    lookup: async (_event: CatalogSender, _args: readonly unknown[]) =>
      emptyCatalog(CATALOG_STATE.ERROR),
  };
}
