import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';

import type {
  BiStream,
  Connection,
  Endpoint,
  EndpointAddr,
  RecvStream,
} from '@number0/iroh';

import { P2P } from '@gyblos/config';
import { isMain } from '@gyblos/runtime';

import { bytes, endpoint, within } from './native-fixture.js';
import { NATIVE_CAPABILITY } from './native-runtime.js';

const READER_ACTIONS = {
  CONNECT: 'connect',
  REQUEST: 'request',
  CLOSED: 'closed',
  SHUTDOWN: 'shutdown',
} as const;

type ReaderAction = (typeof READER_ACTIONS)[keyof typeof READER_ACTIONS];
interface ReaderRequest {
  id: number;
  action: ReaderAction;
  target?: { nodeId: string; addresses: string[] };
  index?: number;
}
interface ReaderReply {
  id: number;
  ok: boolean;
  nodeId?: string;
}

async function readerMain() {
  assert.ok(process.send && NATIVE_CAPABILITY.sdk);
  const { EndpointAddr, EndpointId } = NATIVE_CAPABILITY.sdk;
  let client: Endpoint | undefined, connection: Connection | undefined;
  const retained: { stream: BiStream; receiver: RecvStream }[] = [];
  process.on('message', async (message: ReaderRequest) => {
    try {
      if (message.action === READER_ACTIONS.CONNECT) {
        assert.ok(message.target && !client);
        client = await endpoint();
        connection = await client.connect(
          new EndpointAddr(
            EndpointId.fromString(message.target.nodeId),
            null,
            message.target.addresses,
          ),
          [...Buffer.from(P2P.protocol)],
        );
        connection.setReceiveWindow(1n);
      } else if (message.action === READER_ACTIONS.REQUEST) {
        assert.ok(connection && Number.isSafeInteger(message.index));
        const stream = await connection.openBi();
        retained.push({ stream, receiver: stream.recv });
        await stream.send.writeAll([...bytes('unread-' + message.index)]);
        await stream.send.finish();
      } else if (message.action === READER_ACTIONS.CLOSED) {
        assert.ok(connection);
        await connection.closed();
        assert.notEqual(connection.closeReason(), null);
      } else if (message.action === READER_ACTIONS.SHUTDOWN) {
        await client?.close();
      } else throw new Error('Unknown owned-reader command.');
      process.send!({
        id: message.id,
        ok: true,
        nodeId: client?.id().toString(),
      } satisfies ReaderReply);
      if (message.action === READER_ACTIONS.SHUTDOWN) process.disconnect();
    } catch {
      process.send!({ id: message.id, ok: false } satisfies ReaderReply);
    }
  });
  // The receiver handles remain referenced for the lifetime of the owned child.
  process.once('disconnect', () => {
    void retained.length;
    void client?.close();
  });
}

export async function unreadPeer(target: EndpointAddr) {
  const child = fork(new URL(import.meta.url), [], {
    execArgv: ['--import', import.meta.resolve('tsx')],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let sequence = 0,
    stopped = false;
  const pending = new Map<
    number,
    { resolve: (reply: ReaderReply) => void; reject: (error: Error) => void }
  >();
  child.on('message', (value: ReaderReply) => {
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if (value.ok) waiter.resolve(value);
    else waiter.reject(new Error('Owned unread native peer failed.'));
  });
  const rejectPending = () => {
    for (const waiter of pending.values())
      waiter.reject(new Error('Owned unread peer exited before replying.'));
    pending.clear();
  };
  child.once('exit', rejectPending);
  child.once('error', rejectPending);
  const command = (
    action: ReaderAction,
    fields: Omit<ReaderRequest, 'id' | 'action'> = {},
  ) => {
    const id = ++sequence;
    return within(
      new Promise<ReaderReply>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send(
          { id, action, ...fields } satisfies ReaderRequest,
          (error) => {
            if (error) {
              pending.delete(id);
              reject(new Error('Owned-reader IPC failed.'));
            }
          },
        );
      }),
    );
  };
  const resume = () => {
    if (stopped && child.exitCode === null && child.signalCode === null)
      child.kill('SIGCONT');
    stopped = false;
  };
  const close = async () => {
    resume();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    try {
      await command(READER_ACTIONS.SHUTDOWN);
      await within(exited);
    } catch {
      child.kill('SIGTERM');
      try {
        await within(exited, 1500);
      } catch {
        child.kill('SIGKILL');
        await within(exited);
      }
    }
  };
  try {
    const ready = await command(READER_ACTIONS.CONNECT, {
      target: {
        nodeId: target.id().toString(),
        addresses: target.directAddresses(),
      },
    });
    assert.ok(ready.nodeId);
    return {
      nodeId: ready.nodeId,
      request: (index: number) => command(READER_ACTIONS.REQUEST, { index }),
      pause() {
        assert.ok(child.kill('SIGSTOP'));
        stopped = true;
      },
      resume,
      closed: () => command(READER_ACTIONS.CLOSED),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

if (isMain(import.meta.url)) await readerMain();
