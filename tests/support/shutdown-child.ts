// Child for the shutdown test: waits for the first signal, then runs a slow "state write" stop while the
// parent sends more signals. Writes `done` only if the stop completed.
import { writeFile } from 'node:fs/promises';

import { shutdownSignal } from '@gyblos/runtime';

const [marker] = process.argv.slice(2);
// Stands in for the node's sockets and timers, which keep a real daemon's event loop alive.
const alive = setInterval(() => undefined, 1000);
const shutdown = shutdownSignal();
process.stdout.write('ready\n');
try {
  await shutdown.signalled;
  await new Promise((resolve) => setTimeout(resolve, 600));
  await writeFile(marker!, 'done');
} finally {
  shutdown.dispose();
  clearInterval(alive);
}
