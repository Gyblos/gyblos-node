import { assertProgram } from '../../../packages/payments-x402/src/chain.js';
import { createFacilitator } from '../../../packages/payments-x402/src/facilitator.js';
import { loadConfig, signer } from '../../../scripts/config.js';

const config = await loadConfig();
await assertProgram(config.rpcUrl);
const host = createFacilitator(
  await signer(config, 'facilitator'),
  config.rpcUrl,
  {
    buyer: config.addresses.buyer,
    mint: config.mint,
    payTo: config.addresses.seller,
    authorizer: config.addresses.authorizer,
  },
  process.env.GYBLOS_GATE_RUN_ID,
);
const server = host.app.listen(4022, '127.0.0.1', () => {
  host.cleanup.start({ intervalSecs: 15, abandonGraceSecs: 30 });
  console.log(
    'Gate facilitator ready at http://127.0.0.1:4022 (devnet only; memory storage).',
  );
});
async function shutdown() {
  await host.cleanup.stop();
  server.close(() => process.exit(0));
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
