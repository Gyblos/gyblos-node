// Waits for an owned test child's readiness; startup time never consumes a transport command's budget.
import type { ChildProcess } from 'node:child_process';

import { NativeTestDeadlineError } from './native-fixture';
import { READER_STARTUP } from './native-reader-constants';

export function waitForReaderReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', stopped);
      child.off('error', stopped);
      if (error) reject(error);
      else resolve();
    };
    const message = (value: unknown) => {
      if (
        value &&
        typeof value === 'object' &&
        Object.keys(value).length === 1 &&
        'kind' in value &&
        value.kind === READER_STARTUP.ready
      )
        finish();
    };
    const stopped = () =>
      finish(new Error('Owned reader exited before readiness.'));
    const timer = setTimeout(
      () => finish(new NativeTestDeadlineError()),
      READER_STARTUP.milliseconds,
    );
    child.on('message', message);
    child.once('exit', stopped);
    child.once('error', stopped);
    if (child.exitCode !== null || child.signalCode !== null) stopped();
  });
}
