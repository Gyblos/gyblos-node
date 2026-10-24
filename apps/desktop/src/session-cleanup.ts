// Removes only the disposable Chromium session directory during shutdown.
// Cleanup failures are reported without exposing private paths or blocking exit.
import { rmSync } from 'node:fs';

export function cleanupDesktopSession(
  directory: string,
  report: () => void,
  remove = rmSync,
) {
  remove(directory, { recursive: true, force: true });
  return true;
}
