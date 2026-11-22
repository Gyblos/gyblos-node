// Restarting in place waits for the stopped service to be gone before starting it again: Task Scheduler
// ignores a run while the task still runs (MultipleInstancesPolicy IgnoreNew) and the supervisor answers the
// stop before its process ends; launchd's bootout can return before the agent is torn down, and an
// immediate bootstrap then fails, leaving it unloaded.
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { SERVICE, SERVICE_ERRORS } from './constants';
import { ServiceError } from './service';

const execFileAsync = promisify(execFile);

// The task's state from PowerShell, whose ScheduledTask State names are the same in every Windows language.
// The task name is a constant prefix and a hex digest, so it needs no quoting beyond single quotes.
export async function windowsTaskRunning(task: string) {
  const separator = task.lastIndexOf('\\');
  const folder = task.slice(0, separator);
  const name = task.slice(separator + 1);
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-ScheduledTask -TaskPath '\\${folder}\\' -TaskName '${name}').State`,
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  return stdout.trim() === 'Running';
}

interface StopLimits {
  waitMs: number;
  pollMs: number;
}
const STOP_LIMITS: StopLimits = {
  waitMs: SERVICE.taskStopWaitMs,
  pollMs: SERVICE.taskStopPollMs,
};

// Waits, within a bound, until the service no longer reports running.
export async function waitUntilStopped(
  running: () => Promise<boolean>,
  limits: StopLimits = STOP_LIMITS,
) {
  const deadline = performance.now() + limits.waitMs;
  while (await running()) {
    if (performance.now() >= deadline)
      throw new ServiceError(SERVICE_ERRORS.COMMAND_FAILED);
    await delay(limits.pollMs);
  }
}

export const waitForTaskStop = (
  system: { windowsTaskRunning: (task: string) => Promise<boolean> },
  task: string,
  limits: StopLimits = STOP_LIMITS,
) => waitUntilStopped(() => system.windowsTaskRunning(task), limits);

// Whether launchd still has the agent loaded; quiet, unlike the commands restart shows.
export async function launchAgentLoaded(target: string) {
  try {
    await execFileAsync('launchctl', ['print', target], {
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}
