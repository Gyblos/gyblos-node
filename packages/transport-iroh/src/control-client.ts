// Dials one independently chosen seller on the control ALPN; never opens a paid HTTP stream.
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import {
  CONTROL_ALPN,
  CONTROL_CODES,
  CONTROL_LIMITS,
} from '@gyblos/protocol/constants';
import { controlFail } from '@gyblos/protocol/control-validation';

import { HTTP_OVER_IROH } from './constants';
import {
  controlDeadline,
  readControlFrame,
  writeControlFrame,
} from './control-io';
import { relayOnlyAllows } from './paths';

export interface ControlTransport {
  readonly localNodeId: string;
  readonly remoteNodeId: string;
  exchange(value: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
  settled?(): Promise<void>;
}
export function createControlTransport(
  endpoint: Endpoint,
  remote: EndpointAddr,
  expectedNodeId: string,
  options: { queryMs: number; relayOnly?: boolean },
): ControlTransport & { settled(): Promise<void> } {
  const lifetime = new AbortController();
  const operations = new Set<Promise<unknown>>();
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
          (deadline) =>
            trackControlOperation(operations, async () => {
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
              return exchangeControlStream(
                current,
                value,
                expectedNodeId,
                options.relayOnly,
              );
            }),
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
    async settled() {
      await Promise.allSettled(operations);
    },
    async close() {
      lifetime.abort();
      retire(); // Caller owns the endpoint, which may also carry HTTP v1.
    },
  };
}

function assertControlRoute(connection: Connection, relayOnly?: boolean) {
  if (relayOnly && !relayOnlyAllows(connection))
    return controlFail(CONTROL_CODES.POLICY);
}

function trackControlOperation<T>(
  operations: Set<Promise<unknown>>,
  run: () => Promise<T>,
) {
  const operation = run();
  operations.add(operation);
  void operation.then(
    () => operations.delete(operation),
    () => operations.delete(operation),
  );
  return operation;
}

async function exchangeControlStream(
  connection: Connection,
  value: unknown,
  expectedNodeId: string,
  relayOnly?: boolean,
) {
  if (connection.remoteId().toString() !== expectedNodeId)
    return controlFail(CONTROL_CODES.POLICY);
  assertControlRoute(connection, relayOnly);
  const stream = await connection.openBi();
  assertControlRoute(connection, relayOnly);
  await writeControlFrame(stream, value, CONTROL_LIMITS.requestBytes);
  const response = await readControlFrame(stream, CONTROL_LIMITS.responseBytes);
  assertControlRoute(connection, relayOnly);
  return response;
}
