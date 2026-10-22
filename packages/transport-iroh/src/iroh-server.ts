// Owns iroh server in transport-iroh; it must not know wallets or inference engines.
import type { BiStream, Connection, Endpoint } from '@number0/iroh';

import { HTTP_STATUS, P2P } from '@gyblos/config';

import { connectionSource, createConnectionAdmission } from './admission.js';
import { TRANSPORT_ROUTES } from './constants.js';
import { withDeadline } from './deadline.js';
import { handleIrohConnection } from './iroh-connection.js';
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
  const admission = createConnectionAdmission();
  const connections = new Set<Connection>();
  const streamPeers = new Set<string>();
  let streamsActive = 0;
  let closed = false;

  async function respond(
    stream: BiStream,
    connection: Connection,
    signal: AbortSignal,
  ) {
    const peer = connection.remoteId().toString();
    const close = () => connection.close(P2P.streamCloseCode, []);
    if (streamsActive >= P2P.maxEgressConcurrent || streamPeers.has(peer)) {
      close();
      return;
    }
    streamsActive++;
    streamPeers.add(peer);
    try {
      const bytes = await withDeadline(
        stream.recv.readToEnd(P2P.bodyBytes + P2P.headerBytes),
        P2P.ingressMs,
        close,
      );
      const request = decodeRequest(Uint8Array.from(bytes));
      const release = limiter.enter(peer);
      let response;
      if (!release) {
        response = {
          status: HTTP_STATUS.tooManyRequests,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"error":"Request limit reached"}'),
        };
      } else {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const source = (async () => {
          try {
            if (signal.aborted) throw new Error('Connection closed.');
            if (
              relayOnly &&
              selectedRoute(connection) !== TRANSPORT_ROUTES.RELAY
            )
              throw new Error('Direct paths disabled by seller policy.');
            return await loopbackRequest(
              origin,
              request,
              AbortSignal.any([signal, controller.signal]),
            );
          } finally {
            release();
          }
        })();
        response = await withDeadline(source, P2P.requestMs, () => {
          abort();
          close();
        });
      }
      if (relayOnly && selectedRoute(connection) !== TRANSPORT_ROUTES.RELAY)
        throw new Error('Unexpected direct path.');
      const sending = (async () => {
        await stream.send.writeAll([...encodeResponse(response)]);
        await stream.send.finish();
      })();
      let expired = false;
      try {
        await withDeadline(sending, P2P.egressMs, () => {
          expired = true;
          close(); // Native reset shares the blocked writer's mutex.
        });
      } catch (error) {
        if (expired) await sending.catch(() => undefined);
        throw error;
      }
    } catch {
      close();
    } finally {
      streamsActive--;
      streamPeers.delete(peer);
    }
  }

  async function handle(connection: Connection) {
    const peer = connection.remoteId().toString();
    const releasePeer = admission.established(peer);
    const releaseQuota = releasePeer ? limiter.register(peer) : undefined;
    if (!releasePeer || !releaseQuota) {
      releasePeer?.();
      connection.close(P2P.streamCloseCode, []);
      return;
    }
    connections.add(connection);
    const controller = new AbortController();
    void connection.closed().then(
      () => controller.abort(),
      () => controller.abort(),
    );
    try {
      await handleIrohConnection(
        connection,
        (stream) => respond(stream, connection, controller.signal),
        () => closed,
      );
    } finally {
      controller.abort();
      connections.delete(connection);
      releaseQuota();
      releasePeer();
    }
  }

  const running = (async () => {
    while (!closed) {
      const incoming = await endpoint.acceptNext();
      if (!incoming) break;
      try {
        const source = connectionSource(await incoming.remoteAddr());
        if (!source) {
          await incoming.refuse();
          continue;
        }
        if (!(await incoming.remoteAddrValidated())) {
          await incoming.retry();
          continue;
        }
        const releasePending = admission.pending(source);
        if (!releasePending) {
          await incoming.refuse();
          continue;
        }
        void (async () => {
          let expired = false;
          const native = (async () => (await incoming.accept()).connect())();
          let connection: Connection;
          try {
            connection = await withDeadline(native, P2P.connectMs, () => {
              expired = true;
            });
          } catch {
            // Reserve uncancellable native work until it actually settles.
            if (expired)
              await native.then(
                (late) => late.close(P2P.streamCloseCode, []),
                () => undefined,
              );
            return;
          } finally {
            releasePending();
          }
          if (closed) {
            connection.close(P2P.streamCloseCode, []);
            return;
          }
          void handle(connection).catch(() =>
            connection.close(P2P.streamCloseCode, []),
          );
        })().catch(() => undefined);
      } catch {
        await incoming.ignore().catch(() => undefined);
      }
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
