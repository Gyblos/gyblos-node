// Lazily owns one desktop sandbox service and waits for it during shutdown.
export function createDesktopPaypalRuntime<
  T extends { service: { close(): Promise<void> } },
>(start: () => Promise<T>) {
  let opening: Promise<T> | null = null;
  let closing: Promise<void> | null = null;
  function load(): Promise<T> {
    if (closing) return Promise.reject(new Error('Sandbox is closing.'));
    if (!opening) {
      const next = Promise.resolve()
        .then(start)
        .catch((error: unknown) => {
          if (opening === next) opening = null;
          throw error;
        });
      opening = next;
    }
    return opening;
  }
  function close(): Promise<void> {
    if (!closing) {
      const pending = opening;
      closing = (async () => {
        if (!pending) return;
        const loaded = await pending.catch(() => null);
        if (loaded) await loaded.service.close();
      })();
    }
    return closing;
  }
  return { load, close };
}
