// Owns the free buyer process lifetime. Importing this entry creates no endpoint, timer or files.
import { isMain, onShutdown } from '@gyblos/runtime';

import { FREE_BUYER_CODES } from './constants.js';
import { startFreeBuyer } from './free-startup.js';

export async function main() {
  const host = await startFreeBuyer();
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
if (isMain(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(FREE_BUYER_CODES.CONFIG);
    process.exitCode = 1;
  }
}
