// Holds one synthetic collector writer in a child process until IPC disconnect; never starts a node.
import { isMain } from '@gyblos/runtime';
import { openReceiptFileStore } from '@gyblos/telemetry-file/receipt-store';

async function main() {
  try {
    const store = await openReceiptFileStore({ path: process.argv[2] ?? '' });
    process.once('disconnect', () => {
      void store.close().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    });
    process.send?.({ ready: true });
  } catch {
    process.send?.({ failed: true });
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  }
}
if (isMain(import.meta.url)) void main();
