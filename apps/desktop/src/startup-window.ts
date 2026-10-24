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
  return { prepared() {}, cancelled: () => false };
}
