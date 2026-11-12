// Bounds best-effort receipt work without releasing uncancellable work early or retrying inference: at most
// `slots` jobs at once (one per request a buyer may run side by side); another is dropped and counted.
export function createReceiptWork(milliseconds: number, slots = 1) {
  const active = new Set<Promise<void>>();
  const cancels = new Set<() => void>();
  let closed = false;
  let saved = 0;
  let failed = 0;
  let dropped = 0;
  return {
    health: () => ({ active: active.size > 0, saved, failed, dropped }),
    async run(
      job: (signal: AbortSignal) => Promise<void>,
      external?: AbortSignal,
    ) {
      if (closed || active.size >= slots || external?.aborted) {
        dropped++;
        return false;
      }
      const controller = new AbortController();
      let accounted = false;
      let abort = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancelled = new Promise<boolean>((resolve) => {
        abort = () => {
          if (controller.signal.aborted) return;
          controller.abort();
          if (!accounted) {
            failed++;
            accounted = true;
          }
          resolve(false);
        };
        cancels.add(abort);
        external?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, milliseconds);
      });
      const source = Promise.resolve().then(() => job(controller.signal));
      const settled = source
        .then(
          () => {
            if (!accounted) {
              if (controller.signal.aborted) failed++;
              else saved++;
              accounted = true;
            }
          },
          () => {
            if (!accounted) {
              failed++;
              accounted = true;
            }
          },
        )
        .finally(() => {
          active.delete(settled);
          cancels.delete(abort);
        });
      active.add(settled);
      try {
        return await Promise.race([
          source.then(
            () => !controller.signal.aborted,
            () => false,
          ),
          cancelled,
        ]);
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', abort);
      }
    },
    async close() {
      closed = true;
      for (const cancel of cancels) cancel();
    },
    async settled() {
      await Promise.all(active);
    },
  };
}
