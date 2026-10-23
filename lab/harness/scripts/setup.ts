// Script entry for wallet setup: with --role it sets up one P2P buyer/seller role, otherwise it
// creates the isolated devnet gate wallets.
import { main as setupP2PRole } from '@gyblos/node-app/setup';
import { isMain } from '@gyblos/runtime';

import { setupGate } from '../src/setup.js';

if (isMain(import.meta.url)) {
  if (process.argv.includes('--role')) await setupP2PRole();
  else await setupGate();
}
