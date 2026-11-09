// Owns a separate metadata lock so a delayed history write cannot race another app process.
import { isAbsolute } from 'node:path';

import { desktopActivityPaths } from '@gyblos/config/home';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

import { ActivityHistory } from './activity-history';
import type { SessionActivity } from './activity-model';
import { ActivityObserver } from './activity-observer';
import { DESKTOP_ACTIVITY } from './constants';
import type { PaypalPaymentReference } from './payment-reference-model';

export function createDesktopActivityStorage(
  directory: string | undefined,
  current: () => SessionActivity | null,
  currentReference?: () => PaypalPaymentReference | null,
) {
  const paths =
    directory && isAbsolute(directory) ? desktopActivityPaths(directory) : null;
  let ownership: Promise<ProcessLock> | null = null;
  const read = () =>
    paths
      ? readPrivateFile(paths.state, DESKTOP_ACTIVITY.MAX_BYTES)
      : Promise.resolve(undefined);
  const files = {
    async read() {
      if (!paths) throw new Error('Activity storage unavailable');
      ownership ??= acquireProcessLock(paths.lock);
      await ownership;
      return read();
    },
    async write(text: string) {
      if (!paths || !ownership) throw new Error('Activity storage unavailable');
      const lock = await ownership;
      await lock.verify();
      await writePrivateFile(paths.state, text, DESKTOP_ACTIVITY.MAX_BYTES);
    },
  };
  const history = new ActivityHistory(files);
  return new ActivityObserver(
    history,
    current,
    () => new ActivityHistory({ read, write: files.write }).summary(null),
    async () => {
      const lock = await ownership?.catch(() => null);
      await lock?.release();
    },
    DESKTOP_ACTIVITY.IO_TIMEOUT_MS,
    currentReference,
    () => new ActivityHistory({ read, write: files.write }).references(),
  );
}
