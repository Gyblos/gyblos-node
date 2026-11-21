// Buyer-owned executable entry for a desktop utility process, built separately from the renderer.
import { DEVNET_USDC } from '@gyblos/config';
import { setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { startBuyer } from './buyer-startup';
import { runBuyerSidecar } from './desktop-service';
import { startDesktopBuyer } from './desktop-startup';
import { endpointToken } from './session-requirements';

export async function startBuyerWorker() {
  const port = process.parentPort;
  if (!port) {
    process.exitCode = 1;
    return;
  }
  await runBuyerSidecar(
    port,
    () =>
      startDesktopBuyer(
        {
          environment: process.env,
          prepareRole: () =>
            setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC }),
        },
        (options) =>
          startBuyer({
            ...options,
            desktopChosenPrices: true,
            preparePaidTokenizer: true,
          }),
        process.argv[2],
      ),
    endpointToken,
    (code) => process.exit(code),
  );
}
