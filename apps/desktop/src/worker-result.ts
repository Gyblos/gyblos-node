// Waits for parent acknowledgement before terminating the completed utility probe.
// The result must already represent closed resources; no SDK or process starts here.
import { DESKTOP, PROBE_STATUS } from './constants';
import type { ProbeResult } from './probe-model';

export interface ResultPort {
  once(
    event: 'message',
    listener: (message: { data: unknown }) => void,
  ): unknown;
  postMessage(message: ProbeResult): void;
}
export function reportProbeResult(
  port: ResultPort,
  result: ProbeResult,
  exit: (code: number) => void,
) {
  port.once('message', (message) => {
    if (message.data === DESKTOP.FINISH_ACK)
      exit(result.status === PROBE_STATUS.PASSED ? 0 : 1);
  });
  port.postMessage(result);
}
