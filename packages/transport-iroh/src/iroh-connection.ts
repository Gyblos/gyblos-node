// Serves the streams of one accepted Iroh connection with idle and lifetime limits.
import type { BiStream, Connection } from '@number0/iroh';

import { TRANSPORT_LIMITS } from '@gyblos/config';

import { HTTP_OVER_IROH, IROH_DEADLINES } from './constants.js';

export async function handleIrohConnection(
  connection: Connection,
  respond: (stream: BiStream) => Promise<void>,
  isClosed: () => boolean,
  options: { idleMs?: number; receiveBytes?: number } = {},
) {
  let inFlight = 0;
  let retiring = false;
  let finished = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const closeIfIdle = () => {
    if (inFlight === 0) connection.close(HTTP_OVER_IROH.streamCloseCode, []);
  };
  const armIdle = () => {
    clearTimeout(idle);
    if (inFlight === 0 && !isClosed() && !finished) {
      if (retiring) closeIfIdle();
      else
        idle = setTimeout(
          closeIfIdle,
          options.idleMs ?? IROH_DEADLINES.connectionIdleMs,
        );
    }
  };
  const lifetime = setTimeout(() => {
    retiring = true;
    closeIfIdle();
  }, IROH_DEADLINES.connectionLifetimeMs);
  try {
    connection.setReceiveWindow(
      BigInt(
        options.receiveBytes ??
          HTTP_OVER_IROH.bodyBytes + HTTP_OVER_IROH.headerBytes,
      ) * BigInt(TRANSPORT_LIMITS.maxPeerConcurrent),
    );
    connection.setMaxConcurrentBiStreams(
      BigInt(TRANSPORT_LIMITS.maxPeerConcurrent),
    );
    connection.setMaxConcurrentUniStreams(0n);
    armIdle();
    while (!isClosed()) {
      const stream = await connection.acceptBi();
      if (retiring) {
        void stream.recv
          .stop(HTTP_OVER_IROH.streamCloseCode)
          .catch(() => undefined);
        void stream.send
          .reset(HTTP_OVER_IROH.streamCloseCode)
          .catch(() => undefined);
        closeIfIdle();
        continue;
      }
      clearTimeout(idle);
      inFlight++;
      void respond(stream)
        .catch(() => connection.close(HTTP_OVER_IROH.streamCloseCode, []))
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
    finished = true;
  }
}
