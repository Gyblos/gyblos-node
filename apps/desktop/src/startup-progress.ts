// Carries public startup milestones only. Progress never creates services or changes readiness.
import { STARTUP_PROGRESS } from './constants';

interface StartupOwner {
  contents: unknown;
  mainFrame(): unknown;
  destroyed(): boolean;
}
interface StartupSender {
  sender: unknown;
  senderFrame?: unknown;
}
export interface StartupProgressBridge {
  status(): Promise<unknown>;
  onProgress(listener: (value: unknown) => void): () => void;
}

export function parseStartupProgress(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= STARTUP_PROGRESS.MIN &&
    value <= STARTUP_PROGRESS.MAX &&
    value % (STARTUP_PROGRESS.MAX / STARTUP_PROGRESS.STEPS) === 0
    ? value
    : null;
}

export function createStartupProgress(
  owner: StartupOwner,
  notify: (percentage: number) => void,
  signal: AbortSignal,
) {
  let current: number = STARTUP_PROGRESS.MIN;
  return {
    read(event: StartupSender, args: readonly unknown[]): number | null {
      return !signal.aborted &&
        !owner.destroyed() &&
        args.length === 0 &&
        event.sender === owner.contents &&
        event.senderFrame === owner.mainFrame()
        ? current
        : null;
    },
    publish(percentage: number) {
      if (
        signal.aborted ||
        owner.destroyed() ||
        parseStartupProgress(percentage) === null ||
        percentage <= current
      )
        return;
      current = percentage;
      try {
        notify(current);
      } catch {
        // A closed renderer must not turn cosmetic progress into a startup failure.
      }
    },
  };
}

export function observeStartupProgress(
  bridge: StartupProgressBridge,
  render: (percentage: number) => void,
) {
  let active = true;
  let current: number = STARTUP_PROGRESS.MIN;
  const receive = (value: unknown) => {
    const percentage = parseStartupProgress(value);
    if (!active || percentage === null || percentage <= current) return;
    current = percentage;
    render(current);
  };
  const unsubscribe = bridge.onProgress(receive);
  const read = async () => {
    try {
      receive(await bridge.status());
    } catch {
      // Live milestones remain usable when a snapshot is lost during handoff.
    }
  };
  void read();
  return () => {
    active = false;
    unsubscribe();
  };
}

export function startupPercentage(prepared: boolean, painted: boolean) {
  return (
    ((Number(prepared) + Number(painted)) * STARTUP_PROGRESS.MAX) /
    STARTUP_PROGRESS.STEPS
  );
}
