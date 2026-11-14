// Paces independent positive session scenarios under the real transport query allowance.
// This test helper never retries a prompt or changes product limits, deadlines or financial state.
import { setTimeout as delay } from 'node:timers/promises';

import { ACCEPTANCE } from '@gyblos/lab-harness/acceptance/constants';

type Pause = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
const wait: Pause = (milliseconds, signal) =>
  delay(milliseconds, undefined, { signal });

export function pauseSessionControl(signal?: AbortSignal, pause: Pause = wait) {
  return pause(ACCEPTANCE.controlRefillMs, signal);
}
