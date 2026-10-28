// Exercises the pinned native binding with ephemeral loopback-only endpoints.
// No relay discovery, node configuration, wallet, engine or payment is initialized.
import { Endpoint, EndpointAddr, RelayMode } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { createNodeLifecycle } from '@gyblos/node/lifecycle';
import { GYBLOS_ALPN } from '@gyblos/protocol/constants';

import { DESKTOP, PROBE_STATUS } from './constants';
import type { ProbeResult } from './probe-model';

async function bindLocal() {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.disabled());
  builder.bindAddr(`${LOCALHOST}:0`);
  builder.bindAddr(`${IPV6_LOOPBACK}:0`);
  builder.alpns([[...Buffer.from(GYBLOS_ALPN)]]);
  return builder.bind();
}
async function echo(seller: Endpoint, buyer: Endpoint) {
  const receiving = (async () => {
    const incoming = await seller.acceptNext();
    if (!incoming) throw new Error('Probe connection unavailable.');
    const connection = await (await incoming.accept()).connect();
    const stream = await connection.acceptBi();
    const bytes = await stream.recv.readToEnd(DESKTOP.MAX_BYTES);
    await stream.send.writeAll(bytes);
    await stream.send.finish();
  })();
  const address = new EndpointAddr(seller.id(), null, seller.boundSockets());
  const connection = await buyer.connect(address, [
    ...Buffer.from(GYBLOS_ALPN),
  ]);
  const stream = await connection.openBi();
  await stream.send.writeAll([...Buffer.from(DESKTOP.PAYLOAD)]);
  await stream.send.finish();
  const bytes = await stream.recv.readToEnd(DESKTOP.MAX_BYTES);
  await receiving;
  if (Buffer.from(bytes).toString() !== DESKTOP.PAYLOAD)
    throw new Error('Probe echo mismatch.');
}
export async function runNativeProbe(): Promise<ProbeResult> {
  let seller: Endpoint | undefined;
  let buyer: Endpoint | undefined;
  const endpoints: Endpoint[] = [];
  const lifecycle = createNodeLifecycle(async () => {
    try {
      seller = await bindLocal();
      endpoints.push(seller);
      buyer = await bindLocal();
      endpoints.push(buyer);
      return {
        close: async () => {
          await Promise.all(
            endpoints.splice(0).map((endpoint) => endpoint.close()),
          );
        },
      };
    } catch (error) {
      await Promise.all(
        endpoints.splice(0).map((endpoint) => endpoint.close()),
      );
      throw error;
    }
  });
  for (let cycle = 0; cycle < DESKTOP.CYCLES; cycle += 1) {
    try {
      await lifecycle.start();
      if (!seller || !buyer) throw new Error('Probe lifecycle failed.');
      await echo(seller, buyer);
    } finally {
      await lifecycle.stop();
    }
  }
  return {
    status: PROBE_STATUS.PASSED,
    cycles: DESKTOP.CYCLES,
    roundTrips: DESKTOP.CYCLES,
    closed: true,
  };
}
