// TCP loopback adapter for the structural Iroh client port; peer identities are explicit test inputs.
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';

import { LOCALHOST } from '@gyblos/config';
import type {
  BatchConnection,
  BatchEndpoint,
} from '@gyblos/transport-iroh/batch-client';
import {
  serveBatchChannelStream,
  type BatchChannelService,
} from '@gyblos/transport-iroh/batch-server';

import { batchDeferred } from './batch-deferred';
import { socketStream } from './control-loopback';

export async function batchLoopback(
  service: BatchChannelService,
  ids: { buyerNodeId: string; sellerNodeId: string },
  blocks = false,
) {
  const sockets = new Set<Socket>();
  const running = new Set<Promise<void>>();
  let connections = 0;
  const peers = new Map<
    number,
    ReturnType<typeof batchDeferred<AbortController>>
  >();
  const peer = (port: number) => {
    let value = peers.get(port);
    if (!value) {
      value = batchDeferred<AbortController>();
      peers.set(port, value);
    }
    return value;
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const connection = new AbortController();
    peer(socket.remotePort!).resolve(connection);
    socket.once('close', () => connection.abort());
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const task = serveBatchChannelStream(
      socketStream(socket),
      service,
      ids.buyerNodeId,
      () => socket.destroy(),
      connection.signal,
      () => () => {},
      () => true,
      { blocks },
    );
    running.add(task);
    void task.then(
      () => {
        running.delete(task);
        socket.end();
      },
      () => {
        running.delete(task);
        socket.destroy();
      },
    );
  });
  server.listen(0, LOCALHOST);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic listener unavailable');
  const destination = {
    id: () => ({ toString: () => ids.sellerNodeId }),
    relayUrl: () => null,
  };
  const endpoint: BatchEndpoint<typeof destination> = {
    id: () => ({ toString: () => ids.buyerNodeId }),
    async connect() {
      connections++;
      const closed = batchDeferred<void>();
      const owned = new Set<Socket>();
      const controllers = new Set<AbortController>();
      const connection: BatchConnection = {
        remoteId: destination.id,
        paths: () => [],
        closed: () => closed.promise,
        close() {
          for (const controller of controllers) controller.abort();
          for (const socket of owned) socket.destroy();
          closed.resolve();
        },
        async openBi() {
          const socket = connect({
            host: LOCALHOST,
            port: address.port,
            allowHalfOpen: true,
          });
          owned.add(socket);
          sockets.add(socket);
          socket.once('close', () => {
            owned.delete(socket);
            sockets.delete(socket);
          });
          const stream = socketStream(socket);
          await once(socket, 'connect');
          controllers.add(await peer(socket.localPort!).promise);
          return stream;
        },
      };
      return connection;
    },
  };
  return {
    endpoint,
    destination,
    connections: () => connections,
    settled: () => Promise.allSettled([...running]),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...running]);
    },
  };
}
