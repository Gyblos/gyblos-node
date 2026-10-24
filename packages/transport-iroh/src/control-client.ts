// Dials one independently chosen seller on the control ALPN; never opens a paid HTTP stream.
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import {
  CONTROL_ALPN,
  CONTROL_CODES,
  CONTROL_LIMITS,
} from '@gyblos/protocol/constants';
import { controlFail } from '@gyblos/protocol/control-validation';

import { HTTP_OVER_IROH, TRANSPORT_ROUTES } from './constants.js';
import {
  controlDeadline,
  readControlFrame,
  writeControlFrame,
} from './control-io.js';
import { selectedRoute } from './paths.js';

export interface ControlTransport {
  readonly localNodeId: string;
  readonly remoteNodeId: string;
  exchange(value: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export function createControlTransport(
  endpoint: Endpoint,
  remote: EndpointAddr,
  expectedNodeId: string,
  options: { queryMs: number; relayOnly?: boolean },
): ControlTransport {
  const lifetime = new AbortController();
  let current: Connection | undefined;
  let querying = false;
  let pendingConnect = false;
  function retire() {
    current?.close(HTTP_OVER_IROH.streamCloseCode, []);
    current = undefined;
  }
  return {
    localNodeId: endpoint.id().toString(),
    remoteNodeId: expectedNodeId,
    async exchange(value, signal) {
      if (lifetime.signal.aborted) return controlFail(CONTROL_CODES.CANCELLED);
      if (querying || pendingConnect) return controlFail(CONTROL_CODES.LIMIT);
      querying = true;
      let expired = false;
      const close = () => {
        expired = true;
        retire();
      };
      try {
        return await controlDeadline(
          async (deadline) => {
            if (!current || current.closeReason() !== null) {
              pendingConnect = true;
              let connection: Connection;
              try {
                connection = await endpoint.connect(remote, [
                  ...Buffer.from(CONTROL_ALPN),
                ]);
              } finally {
                pendingConnect = false;
              }
              if (expired || deadline.aborted || lifetime.signal.aborted) {
                connection.close(HTTP_OVER_IROH.streamCloseCode, []);
                return controlFail(CONTROL_CODES.CANCELLED);
              }
              current = connection;
            }
            const connection = current;
            if (connection.remoteId().toString() !== expectedNodeId)
              return controlFail(CONTROL_CODES.POLICY);
            assertControlRoute(connection, options.relayOnly);
            const stream = await connection.openBi();
            assertControlRoute(connection, options.relayOnly);
            await writeControlFrame(stream, value, CONTROL_LIMITS.requestBytes);
            const response = await readControlFrame(
              stream,
              CONTROL_LIMITS.responseBytes,
            );
            assertControlRoute(connection, options.relayOnly);
            return response;
          },
          options.queryMs,
          close,
          signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
        );
      } catch (error) {
        retire();
        throw error;
      } finally {
        querying = false;
      }
    },
    async close() {
      lifetime.abort();
      retire(); // Caller owns the endpoint, which may also carry HTTP v1.
    },
  };
}

function assertControlRoute(connection: Connection, relayOnly?: boolean) {
  if (relayOnly && selectedRoute(connection) !== TRANSPORT_ROUTES.RELAY)
    return controlFail(CONTROL_CODES.POLICY);
}
