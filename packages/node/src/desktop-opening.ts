// One local permission per managed desktop. A late buyer cannot send inference after retirement.
import { desktopOpeningPaths } from '@gyblos/config/home';
import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import {
  acquireProcessLock,
  ensurePrivatePaymentPaths,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

const STATES = { ARMED: 'armed', USED: 'used', RETIRED: 'retired' } as const;
const MAX_BYTES = 512;
export interface DesktopRequestBinding {
  channelId: string;
  sellerNodeId: string;
  requestId: string;
  baseAtomic: string;
}
function binding(value: unknown): DesktopRequestBinding {
  const row = controlObject(value, [
    'channelId',
    'sellerNodeId',
    'requestId',
    'baseAtomic',
  ]);
  return {
    channelId: controlAddress(row.channelId),
    sellerNodeId: controlHex(row.sellerNodeId),
    requestId: controlHex(row.requestId, PAYMENT_SESSION.requestIdBytes),
    baseAtomic: controlAtomic(row.baseAtomic),
  };
}
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
    from: (typeof STATES)[keyof typeof STATES] = STATES.ARMED,
    ref?: DesktopRequestBinding,
  ) => {
    if (!isOpeningIntent(id)) return sessionFail(SESSION_CODES.INVALID);
    await ensurePrivatePaymentPaths(paths);
    const lock = await acquireProcessLock(paths.lock);
    try {
      if (next !== STATES.ARMED) {
        const current = await readPrivateFile(paths.state, MAX_BYTES);
        if (next === STATES.RETIRED && current === next + id) return true;
        if (
          current !== from + id &&
          !(from === STATES.USED && current?.startsWith(from + id + '\n'))
        )
          return false;
      }
      await lock.verify();
      await writePrivateFile(
        paths.state,
        next + id + (ref ? '\n' + JSON.stringify(binding(ref)) : ''),
        MAX_BYTES,
      );
      return true;
    } finally {
      await lock.release();
    }
  };
  return {
    declined: (id: string) => transition(id, STATES.RETIRED, STATES.USED),
    arm: (id: string) => transition(id, STATES.ARMED),
    retire: (id: string) => transition(id, STATES.RETIRED),
    async reference(id: string) {
      if (!isOpeningIntent(id)) return undefined;
      const current = await readPrivateFile(paths.state, MAX_BYTES);
      const prefix = STATES.USED + id + '\n';
      return current?.startsWith(prefix)
        ? binding(JSON.parse(current.slice(prefix.length)))
        : undefined;
    },
    async consume(id: string, ref?: DesktopRequestBinding) {
      if (!(await transition(id, STATES.USED, STATES.ARMED, ref)))
        return sessionFail(SESSION_CODES.UNVERIFIED);
    },
  };
}
