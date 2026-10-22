// Owns process lifetime for the native buyer proxy.
// Payment and call workflows remain explicit separate commands.
import { isMain, onShutdown } from '@gyblos/runtime';

import { startBuyer } from './buyer.js';

export async function main() {
  const host = await startBuyer();
  try {
    await new Promise<void>((resolve) => {
      const dispose = onShutdown(() => {
        dispose();
        resolve();
      });
    });
  } finally {
    await host.close();
  }
}

if (isMain(import.meta.url)) await main();
