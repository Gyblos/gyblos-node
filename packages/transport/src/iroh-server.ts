import type { BiStream, Connection, Endpoint } from '@number0/iroh';

import { HTTP_STATUS, P2P } from '@gyblos/config';

import { withDeadline } from './deadline.js';
import { createPeerLimiter } from './limiter.js';
import { loopbackRequest } from './loopback.js';
import { selectedRoute } from './paths.js';
import { decodeRequest, encodeResponse } from './wire.js';

export function serveIroh(
  endpoint: Endpoint,
  origin: string,
  relayOnly = false,
) {
  const limiter = createPeerLimiter(),
    connections = new Set<Connection>();
  let closed = false,
    pending = 0;
  async function respond(stream: BiStream, connection: Connection) {
    const release = limiter.enter(connection.remoteId().toString());
    if (!release) {
      await stream.send.writeAll([
        ...encodeResponse({
          status: HTTP_STATUS.tooManyRequests,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"error":"Request limit reached"}'),
        }),
      ]);
      await stream.send.finish();
      return;
    }
    const controller = new AbortController();
    void connection
      .closed()
      .then(() => controller.abort())
      .catch(() => controller.abort());
    try {
      await withDeadline(
        (async () => {
          if (relayOnly && selectedRoute(connection) !== 'iroh-relay')
            throw new Error('Direct paths disabled by seller policy.');
          const bytes = await stream.recv.readToEnd(
            P2P.bodyBytes + P2P.headerBytes,
          );
          const request = decodeRequest(Uint8Array.from(bytes));
          const response = await loopbackRequest(
            origin,
            request,
            controller.signal,
          );
          if (relayOnly && selectedRoute(connection) !== 'iroh-relay')
            throw new Error('Unexpected direct path.');
          await stream.send.writeAll([...encodeResponse(response)]);
          await stream.send.finish();
        })(),
        P2P.requestMs,
        () => {
          controller.abort();
          connection.close(P2P.streamCloseCode, []);
        },
      );
    } catch {
      connection.close(P2P.streamCloseCode, []);
    } finally {
      release();
    }
  }
  async function handle(connection: Connection) {
    connections.add(connection);
    connection.setReceiveWindow(
      BigInt(P2P.bodyBytes + P2P.headerBytes) * BigInt(P2P.maxConcurrent),
    );
    connection.setMaxConcurrentBiStreams(BigInt(P2P.maxConcurrent));
    connection.setMaxConcurrentUniStreams(0n);
    try {
      while (!closed) {
        const stream = await connection.acceptBi();
        void respond(stream, connection).catch(() =>
          connection.close(P2P.streamCloseCode, []),
        );
      }
    } catch {
      /* Closing a connection wakes pending native stream reads. */
    } finally {
      connections.delete(connection);
    }
  }
  const running = (async () => {
    while (!closed) {
      const incoming = await endpoint.acceptNext();
      if (!incoming) break;
      if (connections.size + pending >= P2P.maxConnections) {
        await incoming.refuse();
        continue;
      }
      pending++;
      void (async () => {
        let connection: Connection | undefined;
        try {
          connection = await withDeadline(
            (async () => (await incoming.accept()).connect())(),
            P2P.connectMs,
            () => {
              closed = true;
              void endpoint.close();
            },
          );
        } catch {
          return;
        } finally {
          pending--;
        }
        await handle(connection).catch(() =>
          connection.close(P2P.streamCloseCode, []),
        );
      })();
    }
  })();
  void running.catch(() => {
    closed = true;
    for (const connection of connections)
      connection.close(P2P.streamCloseCode, []);
    void endpoint.close();
  });
  return {
    running,
    async close() {
      closed = true;
      for (const connection of connections)
        connection.close(P2P.streamCloseCode, []);
      await endpoint.close();
      await running;
    },
  };
}
