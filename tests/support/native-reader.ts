// Forks a child-process Iroh peer that opens requests but never reads responses, driven over IPC.
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import type {
  BiStream,
  Connection,
  Endpoint,
  EndpointAddr,
  RecvStream,
} from '@number0/iroh';

import { GYBLOS_ALPN } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import { bytes, endpoint, within } from './native-fixture';
import {
  READER_ACTIONS,
  READER_STARTUP,
  type ReaderAction,
} from './native-reader-constants';
import { waitForReaderReady } from './native-reader-ready';
import { NATIVE_CAPABILITY } from './native-runtime';

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

function isReply(value: unknown): value is ReaderReply {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    Number.isSafeInteger(value.id) &&
    typeof value.id === 'number' &&
    value.id > 0 &&
    'ok' in value &&
    typeof value.ok === 'boolean' &&
    (!('nodeId' in value) || typeof value.nodeId === 'string')
  );
}

async function readerMain() {
  assert.ok(process.send && NATIVE_CAPABILITY.sdk);
  const { EndpointAddr, EndpointId } = NATIVE_CAPABILITY.sdk;
  let client: Endpoint | undefined;
  let connection: Connection | undefined;
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
          [...Buffer.from(GYBLOS_ALPN)],
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
      if (message.action === READER_ACTIONS.SHUTDOWN) process.disconnect?.();
    } catch {
      process.send!({ id: message.id, ok: false } satisfies ReaderReply);
    }
  });
  process.send!({ kind: READER_STARTUP.ready });
  // The receiver handles remain referenced for the lifetime of the owned child.
  process.once('disconnect', () => {
    void retained.length;
    void client?.close();
  });
}

export async function unreadPeer(
  target: EndpointAddr,
  options: { spawn?: () => ChildProcess } = {},
) {
  const child =
    options.spawn?.() ??
    fork(new URL(import.meta.url), [], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  let sequence = 0;
  let stopped = false;
  let ready = false;
  const pending = new Map<
    number,
    { resolve: (reply: ReaderReply) => void; reject: (error: Error) => void }
  >();
  child.on('message', (value: unknown) => {
    if (!isReply(value)) return;
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
      if (!ready)
        throw new Error('Owned reader is not ready for shutdown commands.');
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
    await waitForReaderReady(child);
    ready = true;
    const connected = await command(READER_ACTIONS.CONNECT, {
      target: {
        nodeId: target.id().toString(),
        addresses: target.directAddresses(),
      },
    });
    assert.ok(connected.nodeId);
    return {
      nodeId: connected.nodeId,
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
