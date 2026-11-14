// Holds only the JS continuation after a real native FIN; bytes and transport admission stay unchanged.
import type { Connection, Endpoint } from '@number0/iroh';

import { batchDeferred } from './batch-deferred';

export function nativeBatchFinish(ordinal: number) {
  const finished = batchDeferred<void>();
  const following = batchDeferred<void>();
  const released = batchDeferred<void>();
  let connection: Connection | undefined;
  let streams = 0;
  function observeSeller(endpoint: Endpoint) {
    const acceptNext = endpoint.acceptNext.bind(endpoint);
    endpoint.acceptNext = async () => {
      const incoming = await acceptNext();
      if (!incoming) return incoming;
      const accept = incoming.accept.bind(incoming);
      incoming.accept = async () => {
        const accepting = await accept();
        const connect = accepting.connect.bind(accepting);
        accepting.connect = async () => {
          connection = await connect();
          const acceptBi = connection.acceptBi.bind(connection);
          connection.acceptBi = async () => {
            const stream = await acceptBi();
            streams++;
            const send = stream.send;
            if (streams === ordinal) {
              const finish = send.finish.bind(send);
              send.finish = async () => {
                await finish();
                finished.resolve();
                await released.promise;
              };
            }
            if (streams === ordinal + 1) following.resolve();
            return { send, recv: stream.recv };
          };
          return connection;
        };
        return accepting;
      };
      return incoming;
    };
  }
  return {
    observeSeller,
    finished: finished.promise,
    following: following.promise,
    release: () => released.resolve(),
    closed: () => connection?.closeReason() !== null,
  };
}
