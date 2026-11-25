// Buyer-owned executable entry for a desktop utility process, built separately from the renderer.
import { startBuyer } from '@gyblos/buyer/buyer-startup';
import { runBuyerSidecar } from '@gyblos/buyer/desktop-service';
import { startDesktopBuyer } from '@gyblos/buyer/desktop-startup';
import { endpointToken } from '@gyblos/buyer/session-requirements';
import { DEVNET_USDC } from '@gyblos/config';
import { setupRole } from '@gyblos/node/roles';
import { parseAutoPrices } from '@gyblos/protocol/buyer-api';
import { P2P_ROLES } from '@gyblos/protocol/constants';

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
        process.argv[3] === undefined
          ? undefined
          : process.argv[3] === 'null'
            ? null
            : parseAutoPrices(JSON.parse(process.argv[3])),
      ),
    endpointToken,
    (code) => process.exit(code),
  );
}
