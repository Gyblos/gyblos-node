// Buyer-side Iroh transport: connects to the expected NodeId, sends one bounded HTTP exchange per stream
// and reports the observed route. After an uncertain failure it refuses to reconnect.
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { P2P } from '@gyblos/config';

import { TRANSPORT_ROUTES } from './constants.js';
import { withDeadline } from './deadline.js';
import { selectedRoute } from './paths.js';
import type { HttpRequest, Transport, TransportRoute } from './types.js';
import { decodeResponse, encodeRequest } from './wire.js';

export function createIrohTransport(
  endpoint: Endpoint,
  remote: EndpointAddr,
  expectedNodeId: string,
): Transport & { ready(expected?: TransportRoute): Promise<void> } {
  let connection: Connection | undefined;
  let connecting: Promise<Connection> | undefined;
  let connectMs = 0;
  let poisoned = false;
  let expectedRoute: TransportRoute | undefined;
  async function connected() {
    if (poisoned)
      throw new Error('Transport is uncertain; reconcile before reconnecting.');
    if (connection?.closeReason() !== null) {
      connection = undefined;
    }
    if (connection) return connection;
    if (!connecting)
      connecting = (async () => {
        const start = performance.now();
        const result = await withDeadline(
          endpoint.connect(remote, [...Buffer.from(P2P.protocol)]),
          P2P.connectMs,
          () => {
            void endpoint.close();
          },
        );
        if (result.remoteId().toString() !== expectedNodeId) {
          result.close(P2P.streamCloseCode, []);
          throw new Error('Connected NodeId does not match the trusted offer.');
        }
        connectMs = performance.now() - start;
        connection = result;
        return result;
      })().finally(() => {
        connecting = undefined;
      });
    return connecting;
  }
  function assertExpectedRoute(current: Connection) {
    if (expectedRoute && selectedRoute(current) !== expectedRoute)
      throw new Error('Expected route changed before request forwarding.');
  }
  return {
    kind: 'iroh',
    async ready(expected) {
      const current = await connected();
      if (!expected) return;
      const expires = performance.now() + P2P.connectMs;
      while (performance.now() < expires) {
        if (selectedRoute(current) === expected) {
          expectedRoute = expected;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, P2P.routePollMs));
      }
      current.close(P2P.streamCloseCode, []);
      throw new Error('Expected route was not observed; no payment attempted.');
    },
    async exchange(request: HttpRequest) {
      const bytes = encodeRequest(request);
      const current = await connected();
      let directObserved = false;
      let relayObserved = false;
      const observe = () => {
        const route = selectedRoute(current);
        directObserved ||= route === TRANSPORT_ROUTES.DIRECT;
        relayObserved ||= route === TRANSPORT_ROUTES.RELAY;
      };
      observe();
      const poll = setInterval(observe, P2P.routePollMs);
      try {
        const response = await withDeadline(
          (async () => {
            assertExpectedRoute(current);
            const stream = await current.openBi();
            assertExpectedRoute(current);
            await stream.send.writeAll([...bytes]);
            await stream.send.finish();
            return decodeResponse(
              Uint8Array.from(
                await stream.recv.readToEnd(
                  P2P.responseBytes + P2P.headerBytes,
                ),
              ),
            );
          })(),
          P2P.requestMs,
          () => current.close(P2P.streamCloseCode, []),
        );
        observe();
        return {
          ...response,
          transport: selectedRoute(current),
          connectMs,
          directObserved,
          relayObserved,
        };
      } catch (error) {
        poisoned = true;
        current.close(P2P.streamCloseCode, []);
        throw error;
      } finally {
        clearInterval(poll);
      }
    },
    async close() {
      connection?.close(P2P.streamCloseCode, []);
      await endpoint.close();
    },
  };
}
