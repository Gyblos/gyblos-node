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
  const limiter = createPeerLimiter();
  const connections = new Set<Connection>();
  const ingressPeers = new Map<string, number>();
  let ingressActive = 0;
  let closed = false;
  let pending = 0;

  async function respond(stream: BiStream, connection: Connection) {
    const peer = connection.remoteId().toString();
    if (
      ingressActive >= P2P.maxIngressConcurrent ||
      (ingressPeers.get(peer) ?? 0) >= P2P.maxPeerConcurrent
    ) {
      connection.close(P2P.streamCloseCode, []);
      return;
    }
    ingressActive++;
    ingressPeers.set(peer, (ingressPeers.get(peer) ?? 0) + 1);
    let request: ReturnType<typeof decodeRequest>;
    try {
      const bytes = await withDeadline(
        stream.recv.readToEnd(P2P.bodyBytes + P2P.headerBytes),
        P2P.ingressMs,
        () => connection.close(P2P.streamCloseCode, []),
      );
      request = decodeRequest(Uint8Array.from(bytes));
    } catch {
      connection.close(P2P.streamCloseCode, []);
      return;
    } finally {
      ingressActive--;
      const remaining = (ingressPeers.get(peer) ?? 1) - 1;
      if (remaining === 0) ingressPeers.delete(peer);
      else ingressPeers.set(peer, remaining);
    }
    const release = limiter.enter(peer);
    const controller = new AbortController();
    void connection.closed().then(
      () => controller.abort(),
      () => controller.abort(),
    );
    try {
      await withDeadline(
        (async () => {
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
          if (relayOnly && selectedRoute(connection) !== 'iroh-relay')
            throw new Error('Direct paths disabled by seller policy.');
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
        release ? P2P.requestMs : P2P.ingressMs,
        () => {
          controller.abort();
          connection.close(P2P.streamCloseCode, []);
        },
      );
    } catch {
      connection.close(P2P.streamCloseCode, []);
    } finally {
      release?.();
    }
  }

  async function handle(connection: Connection) {
    connections.add(connection);
    let inFlight = 0;
    let retiring = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const closeIfIdle = () => {
      if (inFlight === 0) connection.close(P2P.streamCloseCode, []);
    };
    const armIdle = () => {
      clearTimeout(idle);
      if (inFlight === 0 && !closed) {
        if (retiring) closeIfIdle();
        else idle = setTimeout(closeIfIdle, P2P.connectionIdleMs);
      }
    };
    const lifetime = setTimeout(() => {
      retiring = true;
      closeIfIdle();
    }, P2P.connectionLifetimeMs);
    try {
      connection.setReceiveWindow(
        BigInt(P2P.bodyBytes + P2P.headerBytes) * BigInt(P2P.maxPeerConcurrent),
      );
      connection.setMaxConcurrentBiStreams(BigInt(P2P.maxPeerConcurrent));
      connection.setMaxConcurrentUniStreams(0n);
      armIdle();
      while (!closed) {
        const stream = await connection.acceptBi();
        if (retiring) {
          void stream.recv.stop(P2P.streamCloseCode).catch(() => undefined);
          void stream.send.reset(P2P.streamCloseCode).catch(() => undefined);
          closeIfIdle();
          continue;
        }
        clearTimeout(idle);
        inFlight++;
        void respond(stream, connection)
          .catch(() => connection.close(P2P.streamCloseCode, []))
          .finally(() => {
            inFlight--;
            armIdle();
          });
      }
    } catch {
      /* Closing a connection wakes pending native stream reads. */
    } finally {
      clearTimeout(idle);
      clearTimeout(lifetime);
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
        let expired = false;
        const native = (async () => (await incoming.accept()).connect())();
        let connection: Connection;
        try {
          connection = await withDeadline(native, P2P.connectMs, () => {
            expired = true;
          });
        } catch {
          // The binding cannot cancel this native job. Keep its reservation
          // until it settles, and dispose any late result without serving it.
          if (expired)
            await native.then(
              (late) => late.close(P2P.streamCloseCode, []),
              () => undefined,
            );
          return;
        } finally {
          pending--;
        }
        if (closed) {
          connection.close(P2P.streamCloseCode, []);
          return;
        }
        void handle(connection).catch(() =>
          connection.close(P2P.streamCloseCode, []),
        );
      })().catch(() => undefined);
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
