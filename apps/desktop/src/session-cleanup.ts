// Removes only the disposable Chromium session directory during shutdown.
// Cleanup failures are reported without exposing private paths or blocking exit.
import { rmSync } from 'node:fs';

import { DESKTOP } from './constants';

export function cleanupDesktopSession(
  directory: string,
  report: () => void,
  remove = rmSync,
) {
  try {
    remove(directory, {
      recursive: true,
      force: true,
      maxRetries: DESKTOP.SESSION_CLEANUP_RETRIES,
      retryDelay: DESKTOP.SESSION_CLEANUP_RETRY_MS,
    });
    return true;
  } catch {
    report();
    return false;
  }
}
