import { isMain } from '@gyblos/runtime';

import { setupP2PRole } from '../src/p2p-setup.js';
import { setupGate } from '../src/setup.js';

if (isMain(import.meta.url)) {
  if (process.argv.includes('--role')) await setupP2PRole();
  else await setupGate();
}
