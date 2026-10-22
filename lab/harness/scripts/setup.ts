import { setupP2PRole } from '@gyblos/cli/p2p/setup';
import { setupGate } from '@gyblos/lab-harness/setup';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) {
  if (process.argv.includes('--role')) await setupP2PRole();
  else await setupGate();
}
