// Compatibility only: seller services installed from a checkout before bin.ts run
// `node --import tsx apps/node/src/main.ts`. Without this file they would exit 0 and never restart.
// Nothing imports it; delete it once `gyblos seller status` has told those sellers to reinstall (#235).
import { start } from './daemon';

await start();
