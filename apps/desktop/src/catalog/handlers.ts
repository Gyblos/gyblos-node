// Fixed model-lookup IPC authenticates the current window/main frame and arity.
import {
  CATALOG_STATE,
  emptyCatalog,
  validCatalogQuery,
  type NetworkCatalog,
} from './model';

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
  session: CatalogSession | null,
  window: CatalogWindow,
) {
  const accepts = (event: CatalogSender) =>
    session !== null &&
    !window.destroyed() &&
    event.sender === window.contents &&
    event.senderFrame === window.mainFrame();
  return {
    summary: (event: CatalogSender, args: readonly unknown[]) =>
      accepts(event) && args.length === 0 && session
        ? session.summary()
        : emptyCatalog(CATALOG_STATE.ERROR),
    lookup: async (event: CatalogSender, args: readonly unknown[]) =>
      accepts(event) &&
      args.length === 1 &&
      validCatalogQuery(args[0]) &&
      session
        ? session.lookup(args[0])
        : emptyCatalog(CATALOG_STATE.ERROR),
  };
}
