// The free buyer's receipt runtime and its uploader: confirmed receipts and buyer observations go to
// the metrics collector from the CLI and desktop alike.
import { TRANSPORT_LIMITS } from '@gyblos/config';
import type { ObservationBuffer } from '@gyblos/node/observation-buffer';
import { startRoleUploader } from '@gyblos/node/receipt-uploader-startup';
import {
  createBuyerReceiptRuntime,
  openReceiptStore,
} from '@gyblos/node/receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  assertConfiguredRelay,
  type bindEndpoint,
} from '@gyblos/transport-iroh/endpoint';

export function buyerReceipts(
  endpoint: Awaited<ReturnType<typeof bindEndpoint>>,
  nodeId: string,
  relayOnly: boolean,
  observations?: ObservationBuffer,
) {
  const store = openReceiptStore({
    environment: process.env,
    role: P2P_ROLES.BUYER,
    nodeId: nodeId,
  });
  const signer = async (bytes: Uint8Array<ArrayBuffer>) =>
    Uint8Array.from(
      endpoint
        .secretKey()
        .sign([...bytes])
        .toBytes(),
    );
  const runtime = createBuyerReceiptRuntime({
    endpoint,
    slots: TRANSPORT_LIMITS.maxConcurrent,
    store,
    signer,
    transport: {
      relayOnly,
      relayAllowed: (origin) => {
        try {
          assertConfiguredRelay(origin);
          return true;
        } catch {
          return false;
        }
      },
    },
  });
  // Sends this buyer's confirmed receipts to the metrics collector (CLI and desktop alike).
  const uploader = startRoleUploader({
    environment: process.env,
    store,
    nodeId,
    role: P2P_ROLES.BUYER,
    signer,
    observations,
  });
  return {
    ...runtime,
    async close() {
      try {
        await uploader?.close();
      } finally {
        await runtime.close();
      }
    },
  };
}
