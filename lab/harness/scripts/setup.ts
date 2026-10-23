// Script entry for wallet setup: with --role it sets up one P2P buyer/seller role, otherwise it
// creates the isolated devnet gate wallets.
import { isMain } from '@gyblos/runtime';

import { setupP2PRole } from '../src/p2p-setup.js';
import { setupGate } from '../src/setup.js';

if (isMain(import.meta.url)) {
  if (process.argv.includes('--role')) await setupP2PRole();
  else await setupGate();
}
