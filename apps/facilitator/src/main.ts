import { once } from 'node:events';
import type { Server } from 'node:http';

import {
  CLEANUP,
  FACILITATOR_LOG_PATHS,
  HOSTS,
  LOCALHOST,
  PORTS,
  ROUTES,
} from '@gyblos/config';
import { loadConfig, signer } from '@gyblos/gate/config';
import { WALLET_ROLES } from '@gyblos/gate/constants';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import { isMain } from '@gyblos/runtime';
import { createPrivateLog } from '@gyblos/runtime/private-log';

export async function main() {
  const config = await loadConfig();
  await assertProgram(config.rpcUrl);
  const diagnosticLog = await createPrivateLog(FACILITATOR_LOG_PATHS.devnet);
  let server: Server | undefined;
  try {
    const host = createFacilitator(
      await signer(config, WALLET_ROLES.FACILITATOR),
      config.rpcUrl,
      {
        buyer: config.addresses.buyer,
        mint: config.mint,
        payTo: config.addresses.seller,
        authorizer: config.addresses.authorizer,
      },
      process.env.GYBLOS_GATE_RUN_ID,
      { onDiagnostic: diagnosticLog.write },
    );
    host.app.get(ROUTES.facilitatorDiagnostics, (_request, response) => {
      response.json(diagnosticLog.health());
    });
    server = host.app.listen(PORTS.facilitator, LOCALHOST);
    await once(server, 'listening');
    host.cleanup.start({
      intervalSecs: CLEANUP.intervalSeconds,
      abandonGraceSecs: CLEANUP.abandonGraceSeconds,
    });
    console.log(
      `Gate facilitator ready at ${HOSTS.facilitator} (devnet only; memory storage).`,
    );
    async function shutdown() {
      await host.cleanup.stop();
      server!.close(() => {
        void diagnosticLog.close().then(() => process.exit(0));
      });
    }
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
  } catch (error) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    await diagnosticLog.close();
    throw error;
  }
}

if (isMain(import.meta.url)) await main();
