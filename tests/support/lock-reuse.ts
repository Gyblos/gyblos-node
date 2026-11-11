// Run with --expose-gc. Abandons process locks whose files are then deleted, lets the collector close
// their handles, then checks that a lock file left with this process's pid (an earlier run's, as after a
// container restart) still reads as stale. A file system that reuses the freed inode for that file
// (Linux does) must not make it pass for one this process holds. Prints `ok`, or the round that refused.
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  acquireProcessLock,
  ensurePrivateDirectory,
  type ProcessLock,
} from '@gyblos/runtime/private-file';

const ROUNDS = 40;
const collect = globalThis.gc;
if (!collect) throw new Error('run with --expose-gc');

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-reuse-'));
  await ensurePrivateDirectory(root);
  return root;
}

for (let round = 0; round < ROUNDS; round++) {
  const abandoned = await directory();
  let lock: ProcessLock | undefined = await acquireProcessLock(
    join(abandoned, 'held.lock'),
  );
  await rename(join(abandoned, 'held.lock'), join(abandoned, 'moved.lock'));
  lock = undefined;
  void lock;
  collect();
  await delay(5);
  collect();
  await rm(abandoned, { recursive: true, force: true });
  const root = await directory();
  const path = join(root, 'ledger.lock');
  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, host: hostname() }),
    {
      mode: 0o600,
    },
  );
  try {
    await (await acquireProcessLock(path)).release();
  } catch {
    console.log(`refused in round ${round}`);
    process.exit(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
console.log('ok');
