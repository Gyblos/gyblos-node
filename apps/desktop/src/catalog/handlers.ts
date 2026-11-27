// Fixed model-lookup IPC authenticates the current window/main frame and arity.
import {
  CATALOG_STATE,
  emptyCatalog,
  NETWORK_CATALOG,
  validCatalogQuery,
  type NetworkCatalog,
} from './model';

interface CatalogSession {
  summary(): NetworkCatalog | Promise<NetworkCatalog>;
  lookup(model: string, automatic?: boolean): Promise<NetworkCatalog>;
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
    lookup: async (
      event: CatalogSender,
      args: readonly unknown[],
      automatic = false,
    ) =>
      accepts(event) &&
      args.length === 1 &&
      validCatalogQuery(args[0]) &&
      session
        ? session.lookup(args[0], automatic)
        : emptyCatalog(CATALOG_STATE.ERROR),
  };
}

export function registerCatalogHandlers(
  handle: (
    channel: string,
    handler: (
      event: CatalogSender,
      ...args: unknown[]
    ) => NetworkCatalog | Promise<NetworkCatalog>,
  ) => void,
  session: CatalogSession,
  window: CatalogWindow,
) {
  const handlers = createCatalogHandlers(session, window);
  handle(NETWORK_CATALOG.STATUS_CHANNEL, (event, ...args) =>
    handlers.summary(event, args),
  );
  handle(NETWORK_CATALOG.LOOKUP_CHANNEL, (event, ...args) =>
    handlers.lookup(event, args),
  );
  handle(NETWORK_CATALOG.AUTO_LOOKUP_CHANNEL, (event, ...args) =>
    handlers.lookup(event, args, true),
  );
}
