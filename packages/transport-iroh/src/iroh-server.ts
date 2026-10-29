// Seller-side Iroh server: admits connections, rate-limits peers and bridges each bounded request to the
// local inference origin under ingress and egress deadlines.
import type { BiStream, Connection, Endpoint } from '@number0/iroh';

import {
  HTTP_STATUS,
  TRANSPORT_LIMITS,
  TRANSPORT_TIMEOUTS,
  type TransportLimits,
} from '@gyblos/config';
import {
  CONTROL_ALPN,
  FREE_EXECUTION,
  FREE_STREAM,
  GYBLOS_ALPN,
  RECEIPT_CHANNEL,
} from '@gyblos/protocol/constants';

import {
  connectionFamily,
  connectionSource,
  createConnectionAdmission,
} from './admission';
import { HTTP_OVER_IROH, IROH_DEADLINES } from './constants';
import { handleControlConnection, type ControlService } from './control-server';
import { withDeadline } from './deadline';
import {
  handleFreeExecutionConnection,
  type FreeExecutionService,
} from './free-server';
import { handleIrohConnection } from './iroh-connection';
import { createPeerLimiter } from './limiter';
import { loopbackRequest } from './loopback';
import { relayOnlyAllows } from './paths';
import { createReceiptServer } from './receipt-server';
import type { ReceiptService } from './receipt-service';
import { decodeRequest, encodeResponse } from './wire';

const { streamCloseCode } = HTTP_OVER_IROH;
const { connectMs, requestMs } = TRANSPORT_TIMEOUTS;
const REQUEST_BYTES = HTTP_OVER_IROH.bodyBytes + HTTP_OVER_IROH.headerBytes;

export function serveIroh(
  endpoint: Endpoint,
  origin: string,
  relayOnly = false,
  control?: ControlService,
  freeExecution?: FreeExecutionService,
  limits: TransportLimits = TRANSPORT_LIMITS,
  receipts?: ReceiptService,
) {
  const receiptServer = receipts ? createReceiptServer(receipts) : undefined;
  const limiter = createPeerLimiter(Date.now, limits);
  const admission = createConnectionAdmission(undefined, limits);
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
    const close = () => connection.close(streamCloseCode, []);
    if (streamsActive >= limits.maxEgressConcurrent || streamPeers.has(peer)) {
      close();
      return;
    }
    streamsActive++;
    streamPeers.add(peer);
    try {
      const bytes = await withDeadline(
        stream.recv.readToEnd(REQUEST_BYTES),
        IROH_DEADLINES.ingressMs,
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
            if (relayOnly && !relayOnlyAllows(connection))
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
        response = await withDeadline(source, requestMs, () => {
          abort();
          close();
        });
      }
      if (relayOnly && !relayOnlyAllows(connection))
        throw new Error('Unexpected direct path.');
      const sending = (async () => {
        await stream.send.writeAll([...encodeResponse(response)]);
        await stream.send.finish();
      })();
      let expired = false;
      try {
        await withDeadline(sending, IROH_DEADLINES.egressMs, () => {
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

  async function receiptConnection(
    connection: Connection,
    signal: AbortSignal,
    peer: string,
  ) {
    await receiptServer?.handle(
      connection,
      signal,
      () =>
        !relayOnly || relayOnlyAllows(connection)
          ? limiter.enter(peer)
          : undefined,
      () => closed,
      () => !relayOnly || relayOnlyAllows(connection),
    );
  }

  async function handle(connection: Connection) {
    const peer = connection.remoteId().toString();
    const alpn = Buffer.from(connection.alpn()).toString();
    const family = connectionFamily(alpn);
    const releasePeer = admission.established(peer, family);
    const releaseQuota = releasePeer
      ? limiter.register(peer, family)
      : undefined;
    if (!releasePeer || !releaseQuota) {
      releasePeer?.();
      connection.close(streamCloseCode, []);
      return;
    }
    connections.add(connection);
    const controller = new AbortController();
    void connection.closed().then(
      () => controller.abort(),
      () => controller.abort(),
    );
    try {
      if (alpn === RECEIPT_CHANNEL.alpn && receiptServer) {
        await receiptConnection(connection, controller.signal, peer);
        return;
      }
      if (alpn === CONTROL_ALPN && control) {
        await handleControlConnection(
          connection,
          control,
          controller.signal,
          () => {
            if (relayOnly && !relayOnlyAllows(connection)) return undefined;
            return limiter.enter(peer);
          },
          () => closed,
          () => !relayOnly || relayOnlyAllows(connection),
        );
        return;
      }
      if (
        (alpn === FREE_EXECUTION.alpn || alpn === FREE_STREAM.alpn) &&
        freeExecution
      ) {
        await handleFreeExecutionConnection(
          connection,
          freeExecution,
          controller.signal,
          () =>
            !relayOnly || relayOnlyAllows(connection)
              ? limiter.enter(peer)
              : undefined,
          () => closed,
          () => !relayOnly || relayOnlyAllows(connection),
          alpn === FREE_STREAM.alpn,
        );
        return;
      }
      if (alpn !== GYBLOS_ALPN) {
        connection.close(streamCloseCode, []);
        return;
      }
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
        const allowed = admission.attempt(source ?? 'unknown');
        if (!source || !allowed) {
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
            connection = await withDeadline(native, connectMs, () => {
              expired = true;
            });
          } catch {
            // Reserve uncancellable native work until it actually settles.
            if (expired)
              await native.then(
                (late) => late.close(streamCloseCode, []),
                () => undefined,
              );
            return;
          } finally {
            releasePending();
          }
          if (closed) {
            connection.close(streamCloseCode, []);
            return;
          }
          void handle(connection).catch(() =>
            connection.close(streamCloseCode, []),
          );
        })().catch(() => undefined);
      } catch {
        await incoming.ignore().catch(() => undefined);
      }
    }
  })();
  void running.catch(() => {
    closed = true;
    for (const connection of connections) connection.close(streamCloseCode, []);
    void endpoint.close();
  });
  return {
    running,
    async close() {
      closed = true;
      for (const connection of connections)
        connection.close(streamCloseCode, []);
      await endpoint.close();
      await running;
    },
  };
}
