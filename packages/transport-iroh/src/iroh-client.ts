// Buyer-side Iroh transport: connects to the expected NodeId, sends one bounded HTTP exchange per stream
// and reports the observed route. After an uncertain failure it refuses to reconnect.
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { GYBLOS_ALPN } from '@gyblos/protocol/constants';

import { HTTP_OVER_IROH, IROH_DEADLINES, TRANSPORT_ROUTES } from './constants';
import { withDeadline } from './deadline';
import { selectedRoute } from './paths';
import type { HttpRequest, Transport, TransportRoute } from './types';
import { decodeResponse, encodeRequest } from './wire';

export function createIrohTransport(
  endpoint: Endpoint,
  remote: EndpointAddr,
  expectedNodeId: string,
): Transport & {
  ready(expected?: TransportRoute): Promise<void>;
  retireIdle(): Promise<boolean>;
} {
  let connection: Connection | undefined;
  let connecting: Promise<Connection> | undefined;
  let connectMs = 0;
  let poisoned = false;
  let exchanging = false;
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
          endpoint.connect(remote, [...Buffer.from(GYBLOS_ALPN)]),
          TRANSPORT_TIMEOUTS.connectMs,
          () => {
            void endpoint.close();
          },
        );
        if (result.remoteId().toString() !== expectedNodeId) {
          result.close(HTTP_OVER_IROH.streamCloseCode, []);
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
    async retireIdle() {
      if (exchanging || connecting || poisoned) return false;
      const idle = connection;
      connection = undefined;
      if (idle) {
        idle.close(HTTP_OVER_IROH.streamCloseCode, []);
        await idle.closed();
      }
      return true;
    },
    async ready(expected) {
      const current = await connected();
      if (!expected) return;
      const expires = performance.now() + TRANSPORT_TIMEOUTS.connectMs;
      while (performance.now() < expires) {
        if (selectedRoute(current) === expected) {
          expectedRoute = expected;
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, IROH_DEADLINES.routePollMs),
        );
      }
      current.close(HTTP_OVER_IROH.streamCloseCode, []);
      throw new Error('Expected route was not observed; no payment attempted.');
    },
    async exchange(request: HttpRequest) {
      const bytes = encodeRequest(request);
      const current = await connected();
      exchanging = true;
      let directObserved = false;
      let relayObserved = false;
      const observe = () => {
        const route = selectedRoute(current);
        directObserved ||= route === TRANSPORT_ROUTES.DIRECT;
        relayObserved ||= route === TRANSPORT_ROUTES.RELAY;
      };
      observe();
      const poll = setInterval(observe, IROH_DEADLINES.routePollMs);
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
                  HTTP_OVER_IROH.responseBytes + HTTP_OVER_IROH.headerBytes,
                ),
              ),
            );
          })(),
          TRANSPORT_TIMEOUTS.requestMs,
          () => current.close(HTTP_OVER_IROH.streamCloseCode, []),
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
        current.close(HTTP_OVER_IROH.streamCloseCode, []);
        throw error;
      } finally {
        exchanging = false;
        clearInterval(poll);
      }
    },
    async close() {
      connection?.close(HTTP_OVER_IROH.streamCloseCode, []);
      await endpoint.close();
    },
  };
}
