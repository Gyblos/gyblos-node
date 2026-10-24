// Adapts real TCP loopback sockets to the control stream port for contract tests without native Iroh.
// All identities/signers are ephemeral, and no engine, payment or filesystem is involved.
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';

import { LOCALHOST } from '@gyblos/config';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import type { ControlTransport } from '@gyblos/transport-iroh/control-client';
import {
  readControlFrame,
  writeControlFrame,
  type ControlStream,
} from '@gyblos/transport-iroh/control-io';
import {
  serveControlStream,
  type ControlService,
} from '@gyblos/transport-iroh/control-server';

export function socketStream(socket: Socket): ControlStream {
  let buffered = Buffer.alloc(0);
  let ended = false;
  let failure: Error | undefined;
  let wake = () => {};
  socket.on('data', (bytes: Buffer) => {
    buffered = Buffer.concat([buffered, bytes]);
    wake();
  });
  socket.on('end', () => {
    ended = true;
    wake();
  });
  socket.on('close', () => {
    ended = true;
    wake();
  });
  socket.on('error', (error) => {
    failure = error;
    ended = true;
    wake();
  });
  async function fill() {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    if (failure) throw failure;
  }
  return {
    recv: {
      async readExact(size) {
        while (buffered.length < size && !ended) await fill();
        if (buffered.length < size)
          throw new Error('Synthetic incomplete frame');
        const result = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        return [...result];
      },
      async read(size) {
        while (!buffered.length && !ended) await fill();
        const result = buffered.subarray(0, size);
        buffered = buffered.subarray(result.length);
        return [...result];
      },
    },
    send: {
      writeAll: (bytes) =>
        new Promise((resolve, reject) =>
          socket.write(Buffer.from(bytes), (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      finish: () => new Promise((resolve) => socket.end(resolve)),
    },
  };
}
export async function controlLoopback(service: ControlService, peer: string) {
  const sockets = new Set<Socket>();
  let queries = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    const session = service.open(peer);
    socket.on('error', () => {});
    socket.once('close', () => {
      controller.abort();
      sockets.delete(socket);
    });
    void serveControlStream(
      socketStream(socket),
      service,
      session,
      peer,
      () => socket.destroy(),
      controller.signal,
      () => {
        queries++;
        return () => {};
      },
    ).finally(() => session.close());
  });
  server.listen(0, LOCALHOST);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Synthetic bind failed');
  const port = address.port;
  async function socket() {
    const result = connect({ host: LOCALHOST, port, allowHalfOpen: true });
    sockets.add(result);
    result.once('close', () => sockets.delete(result));
    result.on('error', () => {});
    await once(result, 'connect');
    return result;
  }
  const transport: ControlTransport = {
    localNodeId: peer,
    remoteNodeId: '',
    async exchange(value) {
      const current = await socket();
      try {
        const stream = socketStream(current);
        await writeControlFrame(stream, value, CONTROL_LIMITS.requestBytes);
        return await readControlFrame(stream, CONTROL_LIMITS.responseBytes);
      } finally {
        current.destroy();
      }
    },
    async close() {},
  };
  return {
    socket,
    transport,
    get queries() {
      return queries;
    },
    async close() {
      for (const current of sockets) current.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
