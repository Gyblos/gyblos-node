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

export function parseStartupProgress(_value: unknown): number | null {
  return null;
}

export function createStartupProgress(
  _owner: StartupOwner,
  _notify: (percentage: number) => void,
  _signal: AbortSignal,
) {
  return {
    read(_event: StartupSender, _args: readonly unknown[]): number | null {
      return null;
    },
    publish(_percentage: number) {},
  };
}

export function observeStartupProgress(
  _bridge: StartupProgressBridge,
  _render: (percentage: number) => void,
) {
  return () => {};
}

export function startupPercentage(_prepared: boolean, _painted: boolean) {
  return STARTUP_PROGRESS.MIN;
}
