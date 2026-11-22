import { DESKTOP_UPDATE } from './constants';
import type { DesktopUpdate } from './update-check';

export function createDesktopUpdateReader(
  current: string,
  read: () => Promise<DesktopUpdate>,
  now: () => number = () => performance.now(),
) {
  let latest: DesktopUpdate = { current, available: null };
  let checkedAt: number | undefined;
  let pending: Promise<DesktopUpdate> | undefined;
  return (): Promise<DesktopUpdate> => {
    if (pending) return pending;
    const at = now();
    if (
      checkedAt !== undefined &&
      at - checkedAt < DESKTOP_UPDATE.CHECK_INTERVAL_MS
    )
      return Promise.resolve(latest);
    checkedAt = at;
    pending = Promise.resolve()
      .then(read)
      .then(
        (update) => (latest = update),
        () => latest,
      )
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

export function observeDesktopUpdates(
  read: () => Promise<DesktopUpdate>,
  publish: (update: DesktopUpdate) => void,
) {
  let active = true;
  let pending = false;
  const refresh = async () => {
    if (!active || pending) return;
    pending = true;
    try {
      const update = await read();
      if (active) publish(update);
    } catch {
      /* A failed update check never blocks the window. */
    } finally {
      pending = false;
    }
  };
  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, DESKTOP_UPDATE.CHECK_INTERVAL_MS);
  return () => {
    active = false;
    clearInterval(timer);
  };
}
