// Owns one bounded utility-process probe and requires a clean exit after its summary.
// The worker receives no inherited secrets and exposes no executable renderer commands.
import { join } from 'node:path';

import { utilityProcess } from 'electron';

import { DESKTOP, PROBE_STATUS } from './constants.js';
import {
  failedProbe,
  parseProbeResult,
  type ProbeResult,
} from './probe-model.js';

export function probeInUtility(
  directory: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let result = failedProbe();
    let settled = false;
    const worker = utilityProcess.fork(join(directory, 'worker.cjs'), [], {
      env: {},
      stdio: 'ignore',
    });
    const finish = (summary: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      resolve(summary);
    };
    const abort = () => {
      worker.kill();
      finish(failedProbe());
    };
    const deadline = setTimeout(abort, DESKTOP.DEADLINE_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.on('message', (message: unknown) => {
      result = parseProbeResult(message);
      worker.postMessage(DESKTOP.FINISH_ACK);
    });
    worker.on('exit', (code) =>
      finish(
        code === 0 && result.status === PROBE_STATUS.PASSED
          ? result
          : failedProbe(),
      ),
    );
  });
}
