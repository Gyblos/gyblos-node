// One local permission per managed desktop. A late buyer cannot send inference after retirement.
import { desktopOpeningPaths } from '@gyblos/config/home';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  ensurePrivatePaymentPaths,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

const STATES = { ARMED: 'armed', USED: 'used', RETIRED: 'retired' } as const;
const MAX_BYTES = 128;
export const isOpeningIntent = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    id,
  );

export function desktopOpening(
  environment: Parameters<typeof desktopOpeningPaths>[0],
) {
  const paths = desktopOpeningPaths(environment);
  const transition = async (
    id: string,
    next: (typeof STATES)[keyof typeof STATES],
  ) => {
    if (!isOpeningIntent(id)) return sessionFail(SESSION_CODES.INVALID);
    await ensurePrivatePaymentPaths(paths);
    const lock = await acquireProcessLock(paths.lock);
    try {
      if (next !== STATES.ARMED) {
        const current = await readPrivateFile(paths.state, MAX_BYTES);
        if (next === STATES.RETIRED && current === next + id) return true;
        if (current !== STATES.ARMED + id) return false;
      }
      await lock.verify();
      await writePrivateFile(paths.state, next + id, MAX_BYTES);
      return true;
    } finally {
      await lock.release();
    }
  };
  return {
    arm: (id: string) => transition(id, STATES.ARMED),
    retire: (id: string) => transition(id, STATES.RETIRED),
    async consume(id: string) {
      if (!(await transition(id, STATES.USED)))
        return sessionFail(SESSION_CODES.UNVERIFIED);
    },
  };
}
