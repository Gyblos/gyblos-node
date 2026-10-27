// Owns process lifetime for the native seller daemon.
// Seller composition belongs to the node library.
import { createNode } from '@gyblos/node';
import { isMain } from '@gyblos/runtime';
import { shutdownSignal } from '@gyblos/runtime/process';

// Ctrl-C during startup still exits at once; after startup, the first signal stops the node and later
// ones are absorbed until withdrawal and the public-sequence write finish.
export async function main() {
  const node = createNode();
  let shutdown: ReturnType<typeof shutdownSignal> | undefined;
  try {
    await node.start();
    shutdown = shutdownSignal();
    await shutdown.signalled;
  } finally {
    try {
      await node.stop();
    } finally {
      shutdown?.dispose();
    }
  }
}

if (isMain(import.meta.url)) await main();
