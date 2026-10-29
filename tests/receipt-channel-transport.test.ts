// Checks bounded receipt transport on synthetic streams, real TCP loopback and native Iroh when available.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import test from 'node:test';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import {
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_CODES,
} from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import {
  readControlFrame,
  writeControlFrame,
  type ControlStream,
} from '@gyblos/transport-iroh/control-io';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';
import { createReceiptTransport } from '@gyblos/transport-iroh/receipt-client';
import { createReceiptServer } from '@gyblos/transport-iroh/receipt-server';

import { socketStream } from './support/control-loopback';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';
import { receiptChannelFixture } from './support/receipt-channel';

function memoryStream(frame: Uint8Array, extra = false) {
  let at = 0;
  const reads: number[] = [];
  const written: number[] = [];
  const stream: ControlStream = {
    recv: {
      async readExact(n) {
        reads.push(n);
        const part = frame.slice(at, at + n);
        at += n;
        return [...part];
      },
      async read() {
        return extra ? [1] : [];
      },
    },
    send: {
      async writeAll(bytes) {
        written.push(...bytes);
      },
      async finish() {},
    },
  };
  return { stream, reads, written };
}
void test('receipt server rejects oversized length before requesting its body and releases endpoint lease', async () => {
  const f = await receiptChannelFixture();
  const server = createReceiptServer(f.service);
  const session = server.admission.openConnection(f.buyer.nodeId);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, RECEIPT_CHANNEL.frameBytes + 1);
  const wire = memoryStream(prefix);
  let released = 0;
  let closed = 0;
  await server.serveStream(
    wire.stream,
    session,
    f.buyer.nodeId,
    new AbortController().signal,
    () => () => {
      released++;
    },
    () => true,
    () => {
      closed++;
    },
  );
  assert.deepEqual(wire.reads, [4]);
  assert.equal(wire.written.length, 0);
  assert.equal(released, 1);
  assert.equal(closed, 1);
  session.close();
});
void test('receipt server rejects trailing bytes and endpoint refusal before receipt policy', async () => {
  const f = await receiptChannelFixture();
  let calls = 0;
  const server = createReceiptServer({
    async respond(...args) {
      calls++;
      return f.service.respond(...args);
    },
  });
  const session = server.admission.openConnection(f.buyer.nodeId);
  const wire = memoryStream(encodeControlFrame(f.get), true);
  await server.serveStream(
    wire.stream,
    session,
    f.buyer.nodeId,
    new AbortController().signal,
    () => () => {},
    () => true,
    () => {},
  );
  assert.equal(calls, 0);
  await server.serveStream(
    wire.stream,
    session,
    f.buyer.nodeId,
    new AbortController().signal,
    () => undefined,
    () => true,
    () => {},
  );
  assert.equal(calls, 0);
  session.close();
});
void test('slow receipt ingress is cut off and cannot publish after cancellation', async () => {
  const f = await receiptChannelFixture();
  let calls = 0;
  const server = createReceiptServer(
    {
      async respond(...args) {
        calls++;
        return f.service.respond(...args);
      },
    },
    () => performance.now(),
    20,
  );
  const session = server.admission.openConnection(f.buyer.nodeId);
  let closed = false;
  let released = 0;
  const pending: ControlStream = {
    recv: {
      readExact: () => new Promise(() => {}),
      async read() {
        return [];
      },
    },
    send: {
      async writeAll() {
        assert.fail('late write');
      },
      async finish() {},
    },
  };
  await server.serveStream(
    pending,
    session,
    f.buyer.nodeId,
    new AbortController().signal,
    () => () => {
      released++;
    },
    () => true,
    () => {
      closed = true;
    },
  );
  assert.equal(closed, true);
  assert.equal(released, 1);
  assert.equal(calls, 0);
  session.close();
});
void test('receipt admission aggregates per NodeId and keeps its own global budget', async () => {
  const f = await receiptChannelFixture();
  const server = createReceiptServer(f.service, () => 0);
  const sessions = Array.from(
    { length: CONTROL_CAPACITY.connectionsPerPeer },
    () => server.admission.openConnection(f.buyer.nodeId),
  );
  assert.throws(() => server.admission.openConnection(f.buyer.nodeId));
  const queries = sessions.map((s) => s.beginQuery());
  assert.throws(() => sessions[0]!.beginQuery());
  for (const q of queries) q.cancel();
  for (const s of sessions) s.close();
  const other = createReceiptServer(f.service, () => 0);
  const peers = Array.from({ length: CONTROL_CAPACITY.connections }, (_, i) =>
    other.admission.openConnection(i.toString(16).padStart(64, '0')),
  );
  assert.throws(() => other.admission.openConnection('ff'.repeat(32)));
  for (const p of peers) p.close();
});
void test('TCP loopback exchanges get and confirmation using canonical receipt frames', async () => {
  const f = await receiptChannelFixture();
  const adapter = createReceiptServer(f.service);
  const tasks = new Set<Promise<void>>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const session = adapter.admission.openConnection(f.buyer.nodeId);
    const controller = new AbortController();
    socket.on('error', () => {});
    socket.on('close', () => controller.abort());
    const task = adapter
      .serveStream(
        socketStream(socket),
        session,
        f.buyer.nodeId,
        controller.signal,
        () => () => {},
        () => true,
        () => socket.destroy(),
      )
      .finally(() => session.close());
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    for (const request of [f.get, f.confirm]) {
      const socket = connect(address.port, '127.0.0.1');
      await once(socket, 'connect');
      const io = socketStream(socket);
      try {
        await writeControlFrame(io, request, RECEIPT_CHANNEL.frameBytes);
        const response = await readControlFrame(io, RECEIPT_CHANNEL.frameBytes);
        assert.ok(
          response && typeof response === 'object' && 'result' in response,
        );
      } finally {
        socket.destroy();
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(tasks);
  }
  assert.equal(f.store.calls, 1);
});
void test(
  'native Iroh receipt ALPN fetches and confirms without HTTP forwarding',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const seller = await endpoint();
    const buyer = await endpoint();
    seller.setAlpns([[...Buffer.from(RECEIPT_CHANNEL.alpn)]]);
    const f = await receiptChannelFixture(
      {
        nodeId: seller.id().toString(),
        sign: async (bytes) =>
          Uint8Array.from(
            seller
              .secretKey()
              .sign([...bytes])
              .toBytes(),
          ),
      },
      {
        nodeId: buyer.id().toString(),
        sign: async (bytes) =>
          Uint8Array.from(
            buyer
              .secretKey()
              .sign([...bytes])
              .toBytes(),
          ),
      },
    );
    const server = serveIroh(
      seller,
      'http://127.0.0.1:1',
      false,
      undefined,
      undefined,
      undefined,
      f.service,
    );
    const client = createReceiptTransport(
      buyer,
      seller.addr(),
      seller.id().toString(),
      { queryMs: 2000 },
    );
    try {
      const received = await within(client.exchange(f.get));
      assert.ok(received.result);
      assert.deepEqual(received.result.receipt, f.envelope);
      const confirmed = await within(client.exchange(f.confirm));
      assert.ok(confirmed.result);
      assert.deepEqual(confirmed.result.receipt, f.confirm.params.receipt);
      const duplicate = await within(client.exchange(f.confirm));
      assert.ok(duplicate.result);
      assert.equal(f.store.calls, 1);
    } finally {
      await client.close();
      await client.settled();
      await buyer.close();
      await server.close();
    }
  },
);
