// TCP loopback adapter for the structural Iroh client port; peer identities are explicit test inputs.
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';

import { LOCALHOST } from '@gyblos/config';
import { SESSION_BLOCKS } from '@gyblos/protocol/session-blocks';
import type { RouteProbe } from '@gyblos/transport-iroh';
import type {
  BatchConnection,
  BatchEndpoint,
} from '@gyblos/transport-iroh/batch-client';
import {
  routedBatchService,
  serveBatchChannelStream,
  type BatchChannelService,
} from '@gyblos/transport-iroh/batch-server';

import { batchDeferred } from './batch-deferred';
import { socketStream } from './control-loopback';

const BLOCK_ALPN = Buffer.from(SESSION_BLOCKS.alpn).toString('hex');

export async function batchLoopback(
  service: BatchChannelService,
  ids: { buyerNodeId: string; sellerNodeId: string },
  // A fixed protocol for every connection, or 'alpn' to take it from the protocol each client asks for,
  // as an Iroh server does.
  blocks: boolean | 'alpn' = false,
  // The path the seller observes, as an Iroh connection would report it; none over plain TCP.
  route?: RouteProbe,
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
  const listen = async (blockStreams: boolean) => {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const connection = new AbortController();
      peer(socket.remotePort!).resolve(connection);
      socket.once('close', () => connection.abort());
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const task = serveBatchChannelStream(
        socketStream(socket),
        route ? routedBatchService(service, route) : service,
        ids.buyerNodeId,
        () => socket.destroy(),
        connection.signal,
        () => () => {},
        () => true,
        { blocks: blockStreams },
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
    return { server, port: address.port };
  };
  const plain = blocks === true ? undefined : await listen(false);
  const blockListener = blocks === false ? undefined : await listen(true);
  const portFor = (alpn: readonly number[]) => {
    const wantsBlocks =
      blocks === 'alpn'
        ? Buffer.from(alpn).toString('hex') === BLOCK_ALPN
        : blocks;
    return (wantsBlocks ? blockListener : plain)!.port;
  };
  const destination = {
    id: () => ({ toString: () => ids.sellerNodeId }),
    relayUrl: () => null,
  };
  const endpoint: BatchEndpoint<typeof destination> = {
    id: () => ({ toString: () => ids.buyerNodeId }),
    async connect(_destination, alpn) {
      connections++;
      const port = portFor(alpn);
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
            port,
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
  const servers = [plain, blockListener].filter(
    (listener) => listener !== undefined,
  );
  return {
    endpoint,
    destination,
    connections: () => connections,
    settled: () => Promise.allSettled([...running]),
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map(
          ({ server }) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      await Promise.allSettled([...running]);
    },
  };
}
