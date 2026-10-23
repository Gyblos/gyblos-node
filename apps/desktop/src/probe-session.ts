// Owns one utility worker until its exit; does not initialize Electron or native transport.
// The injected factory permits deterministic lifecycle regressions without real processes.
import { DESKTOP, PROBE_STATUS } from './constants.js';
import {
  failedProbe,
  parseProbeResult,
  type ProbeResult,
} from './probe-model.js';

export interface ProbeWorker {
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
  postMessage(message: string): void;
}

export function runProbeSession(
  fork: () => ProbeWorker,
  signal: AbortSignal,
): Promise<ProbeResult> {
  if (signal.aborted) return Promise.resolve(failedProbe());
  return new Promise((resolve) => {
    let result = failedProbe();
    let settled = false;
    let cancelled = false;
    const worker = fork();
    const finish = (summary: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      resolve(summary);
    };
    const abort = () => {
      cancelled = true;
      worker.kill();
    };
    const deadline = setTimeout(abort, DESKTOP.DEADLINE_MS);
    worker.on('spawn', () => {
      if (cancelled) worker.kill();
    });
    worker.on('message', (message: unknown) => {
      if (cancelled || settled) return;
      result = parseProbeResult(message);
      worker.postMessage(DESKTOP.FINISH_ACK);
    });
    worker.on('exit', (code) =>
      finish(
        !cancelled && code === 0 && result.status === PROBE_STATUS.PASSED
          ? result
          : failedProbe(),
      ),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
