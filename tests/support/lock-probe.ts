// Child-process entry for lock-cases: tries to take the P2P recovery lock and prints whether it was
// rejected or entered.
import { withP2pRecoveryLock } from '@gyblos/payments-x402/recovery/recovery-lock';
import { isMain } from '@gyblos/runtime';

async function main() {
  const paths = JSON.parse(process.argv[2]!) as Parameters<
    typeof withP2pRecoveryLock
  >[0];
  let entered = false;
  try {
    await withP2pRecoveryLock(paths, async () => {
      entered = true;
    });
    console.log(JSON.stringify({ rejected: false, entered }));
  } catch {
    console.log(JSON.stringify({ rejected: true, entered }));
  }
}

if (isMain(import.meta.url)) await main();
