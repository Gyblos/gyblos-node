// Starts the isolated utility worker; lifecycle ownership belongs to the probe session.
// No inherited environment, logs or renderer-supplied executable commands cross this boundary.
import { join } from 'node:path';

import { utilityProcess } from 'electron';

import type { ProbeResult } from './probe-model';
import { runProbeSession } from './probe-session';

export function probeInUtility(
  directory: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  return runProbeSession(
    () =>
      utilityProcess.fork(join(directory, 'worker.cjs'), [], {
        env: {},
        stdio: 'ignore',
      }),
    signal,
  );
}
