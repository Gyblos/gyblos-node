// Displays host-validated update metadata; only the host opens the fixed release page.
import { useEffect, useState } from 'react';

import { DESKTOP_UPDATE } from '../constants';
import type { DesktopUpdate } from '../update-check';
import { observeDesktopUpdates } from '../update-session';
import { Button } from './UI';

declare global {
  interface Window {
    desktopUpdate?: { run(action: unknown): Promise<DesktopUpdate> };
  }
}
export function UpdateNotice() {
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  useEffect(() => {
    const bridge = window.desktopUpdate;
    if (!bridge) return;
    return observeDesktopUpdates(
      () => bridge.run(DESKTOP_UPDATE.STATUS),
      setUpdate,
    );
  }, []);
  if (!update?.available) return null;
  return (
    <div className="ui-toolbar" role="status" aria-label="New Gyblos version">
      <span>Gyblos {update.available} is available.</span>
      <Button
        onClick={() => {
          void window.desktopUpdate?.run(DESKTOP_UPDATE.OPEN).catch(() => {});
        }}
      >
        View update
      </Button>
    </div>
  );
}
