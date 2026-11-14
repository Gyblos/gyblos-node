// Tracks whether an asynchronous status check still belongs to this view.
import { paypalHasUnfinishedSession } from './paypal-model';
import type { DesktopPaypalStatus } from './paypal-session';

export function createPaypalChatMonitor(onStop: () => void) {
  let active = true;
  let generation = 0;
  let knownUnfinished = false;
  return {
    hasKnownUnfinishedSession: () => knownUnfinished,
    observe: ({
      status,
      statusFresh,
    }: {
      status: Pick<DesktopPaypalStatus, 'phase'> | null;
      statusFresh: boolean;
    }) => {
      if (statusFresh && status !== null)
        knownUnfinished = paypalHasUnfinishedSession(status);
    },
    isActive: () => active,
    generation: () => generation,
    isCurrent: (value: number) => active && value === generation,
    stale: (isStatus: boolean, value: number) =>
      isStatus && (!active || value !== generation),
    start: () => {
      active = true;
    },
    stop: () => {
      active = false;
      generation += 1;
      onStop();
    },
  };
}
