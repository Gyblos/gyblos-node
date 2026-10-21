import { setupP2PRole } from '@gyblos/cli/p2p/setup';
import { setupGate } from '@gyblos/gate/setup';
import { isMain } from '@gyblos/runtime';

if (isMain(import.meta.url)) {
  if (process.argv.includes('--role')) await setupP2PRole();
  else await setupGate();
}
