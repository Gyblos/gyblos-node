import { HOSTS, LOCALHOST, PORTS } from '@gyblos/config';
import { loadConfig, signer } from '@gyblos/gate/config';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import { isMain } from '@gyblos/runtime';

export async function main() {
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
  const server = host.app.listen(PORTS.facilitator, LOCALHOST, () => {
    host.cleanup.start({ intervalSecs: 15, abandonGraceSecs: 30 });
    console.log(
      `Gate facilitator ready at ${HOSTS.facilitator} (devnet only; memory storage).`,
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
}
if (isMain(import.meta.url)) await main();
