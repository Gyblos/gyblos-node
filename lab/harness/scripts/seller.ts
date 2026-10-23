// Process entry for the fixed-price gate seller: serves one paid resource on loopback, no inference.
import { HOSTS, LOCALHOST } from '@gyblos/config';
import { WALLET_ROLES } from '@gyblos/config/constants';
import { loadConfig, signer } from '@gyblos/config/wallet';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { isMain } from '@gyblos/runtime';

import { GATE_HOSTS, GATE_PORTS } from '../src/constants.js';
import { createGateSeller } from '../src/fixed-seller.js';

export async function main() {
  const config = await loadConfig();
  await assertProgram(config.rpcUrl);
  const { app } = await createGateSeller({
    rpcUrl: config.rpcUrl,
    facilitatorUrl: HOSTS.facilitator,
    mint: config.mint,
    payTo: config.addresses.seller,
    authorizer: await signer(config, WALLET_ROLES.AUTHORIZER),
    runId: process.env.GYBLOS_GATE_RUN_ID,
  });
  const server = app.listen(GATE_PORTS.seller, LOCALHOST, () => {
    console.log(
      `Gate seller ready at ${GATE_HOSTS.seller} (fixed resource; no inference).`,
    );
  });
  process.once('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

if (isMain(import.meta.url)) await main();
