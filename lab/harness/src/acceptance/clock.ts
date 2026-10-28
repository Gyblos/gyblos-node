// Separates accelerated evidence time from real transport deadlines; real mode waits on wall time.
import { setTimeout as delay } from 'node:timers/promises';

import { ACCEPTANCE_MODES, type AcceptanceMode } from './constants';
import { assertAcceptanceActive } from './errors';

export function createAcceptanceClock(
  mode: AcceptanceMode,
  signal: AbortSignal,
) {
  let synthetic = Date.now();
  return {
    now: () => (mode === ACCEPTANCE_MODES.OLLAMA ? Date.now() : synthetic),
    async advance(milliseconds: number) {
      assertAcceptanceActive(signal);
      if (mode === ACCEPTANCE_MODES.OLLAMA)
        await delay(milliseconds, undefined, { signal });
      else synthetic += milliseconds;
      assertAcceptanceActive(signal);
    },
  };
}
export type AcceptanceClock = ReturnType<typeof createAcceptanceClock>;
