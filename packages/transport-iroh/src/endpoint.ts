// Owns endpoint in transport-iroh; it must not know wallets or inference engines.
import { Endpoint } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST, P2P } from '@gyblos/config';

import { relayModeFromEnv } from './relays.js';

export { assertConfiguredRelay } from './relays.js';

export async function bindEndpoint(
  secret: number[],
  options: {
    relayOnly?: boolean;
    bindAddress?: string;
    externalAddress?: string;
  } = {},
) {
  if (options.relayOnly && options.externalAddress)
    throw new Error('Relay-only mode rejects manual direct candidates.');
  const relayMode = relayModeFromEnv();
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.secretKey(secret);
  builder.alpns([[...Buffer.from(P2P.protocol)]]);
  if (options.relayOnly) {
    builder.bindAddr(`${LOCALHOST}:0`);
    builder.bindAddr(`${IPV6_LOOPBACK}:0`);
  } else if (options.bindAddress) {
    builder.bindAddr(options.bindAddress);
    builder.bindAddr(`${IPV6_LOOPBACK}:0`);
  }
  builder.relayMode(relayMode);
  const endpoint = await builder.bind();
  if (options.externalAddress) {
    try {
      await endpoint.addExternalAddr(options.externalAddress);
    } catch (error) {
      await endpoint.close();
      throw error;
    }
  }
  if (
    options.relayOnly &&
    endpoint
      .boundSockets()
      .some(
        (socket) =>
          !socket.startsWith(`${LOCALHOST}:`) &&
          !socket.startsWith(`${IPV6_LOOPBACK}:`),
      )
  ) {
    await endpoint.close();
    throw new Error('Relay-only endpoint has an external UDP socket.');
  }
  return endpoint;
}
