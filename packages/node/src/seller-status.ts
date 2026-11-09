// Reads back the failure a previous seller start left in status.json; startSeller carries it while it starts.
import { loadJson } from '@gyblos/runtime';

import { SELLER_DAEMON_STATES } from './constants';

const FAILURE_FIELD = /^[A-Za-z0-9_-]{1,64}$/;
const failureField = (value: unknown) =>
  typeof value === 'string' && FAILURE_FIELD.test(value) ? value : undefined;

// The failure the previous start left in status.json, so a seller restarting in a loop still shows why: its
// own failed status, or the failure a start that was killed before finishing was still carrying.
export async function previousFailure(path: string) {
  const previous = await loadJson<Record<string, unknown>>(path).catch(
    () => undefined,
  );
  const failure =
    previous?.status === SELLER_DAEMON_STATES.FAILED
      ? previous
      : previous?.status === SELLER_DAEMON_STATES.STARTING
        ? previous.lastFailure
        : undefined;
  if (typeof failure !== 'object' || failure === null) return undefined;
  const { code, phase } = failure as Record<string, unknown>;
  return { code: failureField(code), phase: failureField(phase) };
}
