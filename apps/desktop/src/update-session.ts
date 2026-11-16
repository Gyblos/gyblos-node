// Coordinates update reads and renderer polling without owning downloads or installation.
import type { DesktopUpdate } from './update-check';

export function createDesktopUpdateReader(
  current: string,
  _read: () => Promise<DesktopUpdate>,
  _now: () => number = () => performance.now(),
) {
  return async (): Promise<DesktopUpdate> => ({ current, available: null });
}

export function observeDesktopUpdates(
  _read: () => Promise<DesktopUpdate>,
  _publish: (update: DesktopUpdate) => void,
) {
  return () => {};
}
