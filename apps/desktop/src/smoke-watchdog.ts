// Bounds desktop startup even when the renderer never reaches its bridge.
// The caller owns the failure action; this module never starts an app or service.
import { DESKTOP } from './constants';

export function armSmokeWatchdog(expire: () => void) {
  const timer = setTimeout(expire, DESKTOP.STARTUP_DEADLINE_MS);
  return () => clearTimeout(timer);
}
