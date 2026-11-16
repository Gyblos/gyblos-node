// Buyer-owned executable entry for a desktop utility process, built separately from the renderer.
import { DEVNET_USDC } from '@gyblos/config';
import { setupRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { startBuyer } from './buyer-startup';
import { runBuyerSidecar } from './desktop-service';
import { prepareDesktopBuyer } from './desktop-startup';
import { endpointToken } from './paid-startup';

export async function startBuyerWorker() {
  const port = process.parentPort;
  if (!port) {
    process.exitCode = 1;
    return;
  }
  await runBuyerSidecar(
    port,
    async () => {
      await prepareDesktopBuyer({
        environment: process.env,
        prepareRole: () =>
          setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC }),
      });
      return startBuyer({ port: 0 });
    },
    endpointToken,
    (code) => process.exit(code),
  );
}
