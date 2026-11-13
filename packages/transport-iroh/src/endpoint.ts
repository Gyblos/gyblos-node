// Binds the native Iroh endpoint with the node key and configured relays; relay-only mode must leave
// no external UDP socket.
import { Endpoint } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import {
  CONTROL_ALPN,
  FREE_EXECUTION,
  FREE_STREAM,
  GYBLOS_ALPN,
  RECEIPT_CHANNEL,
} from '@gyblos/protocol/constants';
import { PAID_STREAM } from '@gyblos/protocol/paid/constants';

import { RELAY_CONFIGURATION_CODES } from './constants';
import {
  RelayConfigurationError,
  relayModeFromEnv,
  type RelayEnvironment,
} from './relays';

export {
  assertConfiguredRelay,
  primaryRelayUrl,
  requireConfiguredRelay,
} from './relays';
export type { RelayEnvironment } from './relays';

export interface BindEndpointOptions {
  relayOnly?: boolean;
  control?: boolean;
  receipts?: boolean;
  freeExecution?: boolean;
  // Accepts the paid stream; payment and settlement belong to the caller's service.
  paidExecution?: boolean;
  batchSessions?: boolean;
  http?: boolean;
  bindAddress?: string;
  externalAddress?: string;
  // Relay origins and token; defaults to the process environment.
  relayEnvironment?: RelayEnvironment;
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
  const relayMode = relayModeFromEnv(options.relayEnvironment);
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.secretKey(secret);
  builder.alpns(
    [
      ...(options.http === false ? [] : [GYBLOS_ALPN]),
      ...(options.control ? [CONTROL_ALPN] : []),
      ...(options.receipts ? [RECEIPT_CHANNEL.alpn] : []),
      ...(options.freeExecution ? [FREE_EXECUTION.alpn, FREE_STREAM.alpn] : []),
      ...(options.paidExecution ? [PAID_STREAM.alpn] : []),
      ...(options.batchSessions ? [BATCH_CHANNEL.alpn] : []),
    ].map((alpn) => [...Buffer.from(alpn)]),
  );
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
