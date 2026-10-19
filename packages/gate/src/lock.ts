import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { FILE_MODES } from '@gyblos/config';
import { GateError } from '@gyblos/payments-x402/chain';

export async function withExclusiveLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  const handle = await open(path, 'wx', FILE_MODES.privateFile).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new GateError(
          'BUYER_BUSY',
          'Another buyer or an interrupted process holds the gate lock. Reconcile before removing a stale lock.',
        );
      throw error;
    },
  );
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
