// Reopens the collector in a separately terminated, credential-free child; IPC contains counters only.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { acceptanceAssert, assertAcceptanceActive } from './errors';
import { COLLECTOR_ACCEPTANCE } from './receipt-collector-constants';

export async function restartAcceptanceCollector(
  root: string,
  signal: AbortSignal,
) {
  assertAcceptanceActive(signal);
  const child = fork(
    fileURLToPath(new URL(COLLECTOR_ACCEPTANCE.worker, import.meta.url)),
    [],
    {
      cwd: root,
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
        GYBLOS_HOME: root,
        GYBLOS_LAB_HOME: root,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  let killing: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    killing ??= setTimeout(
      () => child.kill('SIGKILL'),
      COLLECTOR_ACCEPTANCE.killMs,
    );
  };
  let failed = false;
  let duplicates: number | undefined;
  const timeout = setTimeout(() => {
    failed = true;
    stop();
  }, COLLECTOR_ACCEPTANCE.restartMs);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  child.on('message', (value: unknown) => {
    try {
      acceptanceAssert(
        duplicates === undefined &&
          JSON.stringify(value).length <= COLLECTOR_ACCEPTANCE.reportBytes,
      );
      const input = controlObject(value, ['duplicates']);
      duplicates = controlInteger(input.duplicates, 2);
    } catch {
      failed = true;
      stop();
    }
  });
  child.once('error', () => {
    failed = true;
  });
  try {
    const code = await new Promise<number | null>((resolve) =>
      child.once('close', resolve),
    );
    assertAcceptanceActive(signal);
    acceptanceAssert(!failed && code === 0 && duplicates !== undefined);
    return duplicates;
  } finally {
    clearTimeout(timeout);
    clearTimeout(killing);
    signal.removeEventListener('abort', stop);
  }
}
