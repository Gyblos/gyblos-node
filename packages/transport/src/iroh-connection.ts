import type { BiStream, Connection } from '@number0/iroh';

import { P2P } from '@gyblos/config';

export async function handleIrohConnection(
  connection: Connection,
  respond: (stream: BiStream) => Promise<void>,
  isClosed: () => boolean,
) {
  let inFlight = 0;
  let retiring = false;
  let finished = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const closeIfIdle = () => {
    if (inFlight === 0) connection.close(P2P.streamCloseCode, []);
  };
  const armIdle = () => {
    clearTimeout(idle);
    if (inFlight === 0 && !isClosed() && !finished) {
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
    while (!isClosed()) {
      const stream = await connection.acceptBi();
      if (retiring) {
        void stream.recv.stop(P2P.streamCloseCode).catch(() => undefined);
        void stream.send.reset(P2P.streamCloseCode).catch(() => undefined);
        closeIfIdle();
        continue;
      }
      clearTimeout(idle);
      inFlight++;
      void respond(stream)
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
    finished = true;
  }
}
