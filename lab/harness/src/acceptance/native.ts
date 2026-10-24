// Owns ephemeral native Iroh endpoints on loopback, with relays disabled and only control ALPN enabled.
// There is no TCP/mock fallback, external relay, paid ALPN or funded identity.
import type { Endpoint } from '@number0/iroh';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { CONTROL_ALPN } from '@gyblos/protocol/constants';
import type { Signer } from '@gyblos/protocol/signing';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';
import type { ControlService } from '@gyblos/transport-iroh/control-server';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { ACCEPTANCE, ACCEPTANCE_CODES } from './constants.js';
import { AcceptanceError } from './errors.js';

async function endpoint(secret?: number[]): Promise<Endpoint> {
  try {
    const { Endpoint, RelayMode } = await import('@number0/iroh');
    const builder = Endpoint.builder();
    builder.applyMinimal();
    builder.relayMode(RelayMode.disabled());
    builder.bindAddr(`${LOCALHOST}:0`);
    builder.bindAddr(`${IPV6_LOOPBACK}:0`);
    builder.alpns([[...Buffer.from(CONTROL_ALPN)]]);
    if (secret) builder.secretKey(secret);
    return await builder.bind();
  } catch {
    throw new AcceptanceError(ACCEPTANCE_CODES.NATIVE_UNAVAILABLE);
  }
}

export async function createNativeAcceptanceNode(secret: number[]) {
  const seller = await endpoint(secret);
  let bridge: ReturnType<typeof serveIroh> | undefined;
  const nodeSigner: Signer = async (bytes) =>
    Uint8Array.from(
      seller
        .secretKey()
        .sign([...bytes])
        .toBytes(),
    );
  return {
    nodeId: seller.id().toString(),
    nodeSigner,
    directAddresses: seller.addr().directAddresses(),
    start(service: ControlService) {
      bridge = serveIroh(seller, ACCEPTANCE.unusedHttpOrigin, false, service);
    },
    async client(owner: string, now: () => number) {
      const buyer = await endpoint();
      const transport = createControlTransport(
        buyer,
        seller.addr(),
        seller.id().toString(),
        { queryMs: ACCEPTANCE.queryMs },
      );
      const client = createBuyerControlClient(transport, {
        owner,
        nodeId: seller.id().toString(),
        relayAllowed: () => false,
        now,
      });
      return {
        client,
        async close() {
          await client.close();
          await buyer.close();
        },
      };
    },
    async close() {
      if (bridge) await bridge.close();
      else await seller.close();
    },
  };
}
export type AcceptanceWire = Awaited<
  ReturnType<typeof createNativeAcceptanceNode>
>;
