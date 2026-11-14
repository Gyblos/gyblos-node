// Buyer-owned executable entry for a desktop utility process, built separately from the renderer.
import { startBuyer } from './buyer-startup';
import { runBuyerSidecar } from './desktop-service';
import { endpointToken } from './paid-startup';

export async function startBuyerWorker() {
  const port = process.parentPort;
  if (!port) {
    process.exitCode = 1;
    return;
  }
  await runBuyerSidecar(
    port,
    () => startBuyer({ port: 0 }),
    endpointToken,
    (code) => process.exit(code),
  );
}
