// Coordinates the small startup window and main window without accessing secrets.
// Closing either window cancels the handoff; readiness never starts networking.
export interface StartupWindow {
  isDestroyed(): boolean;
  show(): void;
  close(): void;
  destroy(): void;
  once(event: 'closed' | 'ready-to-show', callback: () => void): unknown;
}

export function startupHandoff(main: StartupWindow, loading: StartupWindow) {
  let prepared = false;
  let painted = false;
  let cancelled = false;
  let completed = false;
  const reveal = () => {
    if (!prepared || !painted || cancelled || completed || main.isDestroyed())
      return;
    completed = true;
    main.show();
    if (!loading.isDestroyed()) loading.destroy();
  };
  loading.once('ready-to-show', () => {
    if (!cancelled && !completed && !loading.isDestroyed()) loading.show();
  });
  main.once('ready-to-show', () => {
    painted = true;
    reveal();
  });
  loading.once('closed', () => {
    if (completed || cancelled) return;
    cancelled = true;
    if (!main.isDestroyed()) main.close();
  });
  main.once('closed', () => {
    cancelled = true;
    if (!loading.isDestroyed()) loading.destroy();
  });
  return {
    prepared() {
      prepared = true;
      reveal();
    },
    cancelled: () => cancelled,
  };
}
