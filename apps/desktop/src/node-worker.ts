// Keeps an ephemeral loopback endpoint alive in an isolated utility process.
// No relays, discovery, wallet, engine, gateway or payment service is initialized.
import { bindLocal } from './native-probe';
import { runLocalNode } from './node-runtime';

async function main() {
  const port = process.parentPort;
  if (!port) {
    process.exit(1);
    return;
  }
  await runLocalNode(
    port,
    async () => {
      const endpoint = await bindLocal();
      return { close: () => endpoint.close() };
    },
    (code) => process.exit(code),
  );
}
void main();
