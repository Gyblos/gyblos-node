// Restarting the Windows scheduled task: Task Scheduler ignores a run while the task still runs
// (MultipleInstancesPolicy IgnoreNew) and the supervisor answers the stop before its process ends, so restart
// waits for the task to end before running it again.
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

// Waits, within a bound, until Task Scheduler no longer reports the task running.
export async function waitForTaskStop(
  system: { windowsTaskRunning: (task: string) => Promise<boolean> },
  task: string,
  limits: { waitMs: number; pollMs: number } = {
    waitMs: SERVICE.taskStopWaitMs,
    pollMs: SERVICE.taskStopPollMs,
  },
) {
  const deadline = performance.now() + limits.waitMs;
  while (await system.windowsTaskRunning(task)) {
    if (performance.now() >= deadline)
      throw new ServiceError(SERVICE_ERRORS.COMMAND_FAILED);
    await delay(limits.pollMs);
  }
}
