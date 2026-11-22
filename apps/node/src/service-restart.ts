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
interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const REAL_CLOCK: Clock = {
  now: () => performance.now(),
  sleep: (ms) => delay(ms),
};
const TASK_STOP_LIMITS: StopLimits = {
  waitMs: SERVICE.taskStopWaitMs,
  pollMs: SERVICE.taskStopPollMs,
};
// launchd gives the daemon ExitTimeOut (stopTimeoutSeconds) to finish its shutdown before killing it, so
// restart waits that long plus room for teardown and the last status probe.
const AGENT_STOP_LIMITS: StopLimits = {
  waitMs:
    (SERVICE.stopTimeoutSeconds + SERVICE.agentStopMarginSeconds) *
    SERVICE.secondMs,
  pollMs: SERVICE.taskStopPollMs,
};

// Waits, within a bound, until the service no longer reports running.
export async function waitUntilStopped(
  running: () => Promise<boolean>,
  limits: StopLimits = TASK_STOP_LIMITS,
  clock: Clock = REAL_CLOCK,
) {
  const deadline = clock.now() + limits.waitMs;
  while (await running()) {
    if (clock.now() >= deadline)
      throw new ServiceError(SERVICE_ERRORS.COMMAND_FAILED);
    await clock.sleep(limits.pollMs);
  }
}

export const waitForTaskStop = (
  system: { windowsTaskRunning: (task: string) => Promise<boolean> },
  task: string,
  limits: StopLimits = TASK_STOP_LIMITS,
  clock: Clock = REAL_CLOCK,
) => waitUntilStopped(() => system.windowsTaskRunning(task), limits, clock);

export const waitForAgentUnload = (
  system: { launchAgentLoaded: (target: string) => Promise<boolean> },
  target: string,
  clock: Clock = REAL_CLOCK,
) =>
  waitUntilStopped(
    () => system.launchAgentLoaded(target),
    AGENT_STOP_LIMITS,
    clock,
  );

// Whether launchd still has the agent loaded; quiet, unlike the commands restart shows. A probe that hangs
// is cut off and counts as still loaded, so the wait keeps its own deadline instead of bootstrapping early.
export async function launchAgentLoaded(target: string) {
  try {
    await execFileAsync('launchctl', ['print', target], {
      encoding: 'utf8',
      timeout: SERVICE.agentProbeMs,
    });
    return true;
  } catch (error) {
    return (error as { killed?: boolean }).killed === true;
  }
}
