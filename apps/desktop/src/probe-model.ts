// Validates the utility-process result before it crosses the renderer bridge.
// Only a closed summary is allowed; native errors, identities and addresses stay out.
import { DESKTOP, PROBE_STATUS } from './constants.js';

export type ProbeStatus = (typeof PROBE_STATUS)[keyof typeof PROBE_STATUS];
export interface ProbeResult {
  status: typeof PROBE_STATUS.PASSED | typeof PROBE_STATUS.FAILED;
  cycles: number;
  roundTrips: number;
  closed: boolean;
}
export const failedProbe = (): ProbeResult => ({
  status: PROBE_STATUS.FAILED,
  cycles: 0,
  roundTrips: 0,
  closed: false,
});
export function parseProbeResult(value: unknown): ProbeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return failedProbe();
  if (Object.keys(value).sort().join(',') !== 'closed,cycles,roundTrips,status')
    return failedProbe();
  if (
    !('status' in value) ||
    !('cycles' in value) ||
    !('roundTrips' in value) ||
    !('closed' in value)
  )
    return failedProbe();
  if (
    value.status !== PROBE_STATUS.PASSED ||
    value.cycles !== DESKTOP.CYCLES ||
    value.roundTrips !== DESKTOP.CYCLES ||
    value.closed !== true
  )
    return failedProbe();
  return {
    status: PROBE_STATUS.PASSED,
    cycles: DESKTOP.CYCLES,
    roundTrips: DESKTOP.CYCLES,
    closed: true,
  };
}

export { DESKTOP, PROBE_STATUS } from './constants.js';

export { armSmokeWatchdog } from './smoke-watchdog.js';

export { reportProbeResult, type ResultPort } from './worker-result.js';
