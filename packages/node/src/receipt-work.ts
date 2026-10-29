// Bounds best-effort receipt work without releasing uncancellable work early or retrying inference.
export function createReceiptWork(milliseconds: number) {
  let active: Promise<void> | undefined;
  let cancelActive: (() => void) | undefined;
  let closed = false;
  let saved = 0;
  let failed = 0;
  let dropped = 0;
  return {
    health: () => ({ active: Boolean(active), saved, failed, dropped }),
    async run(
      job: (signal: AbortSignal) => Promise<void>,
      external?: AbortSignal,
    ) {
      if (closed || active || external?.aborted) {
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
        cancelActive = abort;
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
          active = undefined;
          cancelActive = undefined;
        });
      active = settled;
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
      cancelActive?.();
    },
    async settled() {
      await active;
    },
  };
}
