// Displays host-validated update metadata; only the host opens the fixed release page.
import { ArrowCircleUp } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { DESKTOP_UPDATE } from '../constants';
import type { DesktopUpdate } from '../update-check';
import { observeDesktopUpdates } from '../update-session';
import { BUTTON_VARIANT } from './constants';
import { FormActions } from './Form';
import { Modal } from './Modal';
import { MotionPresence } from './Motion';
import { Button } from './UI';

declare global {
  interface Window {
    desktopUpdate?: { run(action: unknown): Promise<DesktopUpdate> };
  }
}
export function useDesktopUpdate() {
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  useEffect(() => {
    const bridge = window.desktopUpdate;
    if (!bridge) return;
    return observeDesktopUpdates(
      () => bridge.run(DESKTOP_UPDATE.STATUS),
      setUpdate,
    );
  }, []);
  return update;
}
export function UpdateNotice({
  update,
  open,
  setOpen,
}: {
  update: DesktopUpdate | null;
  open: boolean;
  setOpen(value: boolean): void;
}) {
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!open) setFailed(false);
  }, [open]);
  async function openDownload() {
    setOpening(true);
    try {
      if (!window.desktopUpdate) {
        setFailed(true);
        return;
      }
      await window.desktopUpdate.run(DESKTOP_UPDATE.OPEN);
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }
  if (!update?.available) return null;
  return (
    <>
      <Button
        className="pk-update"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ArrowCircleUp size={14} weight="fill" aria-hidden="true" />
        Update to {update.available}
      </Button>
      <MotionPresence>
        {open && (
          <Modal
            title={'Gyblos ' + update.available}
            description="A new desktop version is available."
            size="sm"
            close={() => setOpen(false)}
          >
            <p className="ui-help-text">
              You have {update.current}. Your chats, API keys and wallet stay on
              this computer when you update.
            </p>
            {failed && <p role="alert">Could not open the download page.</p>}
            <FormActions>
              <Button onClick={() => setOpen(false)}>Later</Button>
              <Button
                variant={BUTTON_VARIANT.PRIMARY}
                disabled={opening}
                onClick={() => void openDownload()}
              >
                Open download page
              </Button>
            </FormActions>
          </Modal>
        )}
      </MotionPresence>
    </>
  );
}
