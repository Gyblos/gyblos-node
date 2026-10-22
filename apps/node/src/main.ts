// Owns process lifetime for the native seller daemon.
// Seller composition belongs to the node library.
import { createNode } from '@gyblos/node';
import { isMain, onShutdown } from '@gyblos/runtime';

export async function main() {
  const node = createNode();
  try {
    await node.start();
    await new Promise<void>((resolve) => {
      const dispose = onShutdown(() => {
        dispose();
        resolve();
      });
    });
  } finally {
    await node.stop();
  }
}

if (isMain(import.meta.url)) await main();
