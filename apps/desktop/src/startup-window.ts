// Coordinates the small startup window and main window without accessing secrets.
// Closing either window cancels the handoff; readiness never starts networking.
import { startupPercentage } from './startup-progress';

export interface StartupWindow {
  isDestroyed(): boolean;
  show(): void;
  close(): void;
  destroy(): void;
  once(event: 'closed' | 'ready-to-show', callback: () => void): unknown;
}

export function startupHandoff(
  main: StartupWindow,
  loading: StartupWindow,
  signal?: AbortSignal,
  onProgress?: (percentage: number) => void,
) {
  let prepared = false;
  let painted = false;
  let cancelled = false;
  let completed = false;
  const cancel = () => {
    cancelled = true;
    signal?.removeEventListener('abort', cancel);
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const report = () => {
    if (!cancelled && !completed)
      onProgress?.(startupPercentage(prepared, painted));
  };
  const reveal = () => {
    if (!prepared || !painted || cancelled || completed || main.isDestroyed())
      return;
    completed = true;
    signal?.removeEventListener('abort', cancel);
    main.show();
    if (!loading.isDestroyed()) loading.destroy();
  };
  loading.once('ready-to-show', () => {
    if (!cancelled && !completed && !loading.isDestroyed()) loading.show();
  });
  main.once('ready-to-show', () => {
    if (cancelled || completed) return;
    painted = true;
    report();
    reveal();
  });
  loading.once('closed', () => {
    if (completed || cancelled) return;
    cancel();
    if (!main.isDestroyed()) main.close();
  });
  main.once('closed', () => {
    cancel();
    if (!loading.isDestroyed()) loading.destroy();
  });
  report();
  return {
    prepared() {
      if (prepared || cancelled || completed) return;
      prepared = true;
      report();
      reveal();
    },
    cancelled: () => cancelled,
  };
}

// Fatal startup must not escape to app.exit while a resident node still owns resources.
export async function settleDesktopStartup(
  loading: Promise<void>,
  closeNode: () => Promise<void>,
) {
  try {
    await loading;
  } catch (error) {
    await closeNode();
    throw error;
  }
}
