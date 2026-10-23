// Binds the native Iroh endpoint with the node key and configured relays; relay-only mode must leave
// no external UDP socket.
import { Endpoint } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { GYBLOS_ALPN } from '@gyblos/protocol/constants';

import { RELAY_CONFIGURATION_CODES } from './constants.js';
import { RelayConfigurationError, relayModeFromEnv } from './relays.js';

export { assertConfiguredRelay, requireConfiguredRelay } from './relays.js';

export interface BindEndpointOptions {
  relayOnly?: boolean;
  bindAddress?: string;
  externalAddress?: string;
}

export async function bindEndpoint(
  secret: number[],
  options: BindEndpointOptions = {},
) {
  if (options.relayOnly && options.externalAddress)
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.DIRECT_CANDIDATE,
      'Relay-only mode rejects manual direct candidates.',
    );
  const relayMode = relayModeFromEnv();
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.secretKey(secret);
  builder.alpns([[...Buffer.from(GYBLOS_ALPN)]]);
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
