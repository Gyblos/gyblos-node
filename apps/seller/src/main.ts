import { HOSTS, LOCALHOST, PORTS } from '@gyblos/config';
import { loadConfig, signer } from '@gyblos/gate/config';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { createGateSeller } from '@gyblos/payments-x402/seller';

const config = await loadConfig();
await assertProgram(config.rpcUrl);
const { app } = await createGateSeller({
  rpcUrl: config.rpcUrl,
  facilitatorUrl: HOSTS.facilitator,
  mint: config.mint,
  payTo: config.addresses.seller,
  authorizer: await signer(config, 'authorizer'),
  runId: process.env.GYBLOS_GATE_RUN_ID,
});
const server = app.listen(PORTS.seller, LOCALHOST, () => {
  console.log(
    `Gate seller ready at ${HOSTS.seller} (fixed resource; no inference).`,
  );
});
process.once('SIGTERM', () => {
  server.close(() => process.exit(0));
});
process.once('SIGINT', () => {
  server.close(() => process.exit(0));
});
