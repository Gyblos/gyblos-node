// Proves real native egress expiry and slot reclamation with deterministic setup.
// Test-only preloading and process control never change product transport or payments.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  BiStream,
  Connection,
  EndpointAddr,
  SendStream,
} from '@number0/iroh';

import { HTTP_STATUS, TRANSPORT_LIMITS } from '@gyblos/config';
import {
  HTTP_OVER_IROH,
  IROH_DEADLINES,
} from '@gyblos/transport-iroh/constants';

import {
  fixture,
  fixtureRequest,
  NativeTestDeadlineError,
  within,
} from './support/native-fixture.js';
import { unreadPeer } from './support/native-reader.js';
import {
  NATIVE_CAPABILITY,
  NATIVE_TEST_OPTIONS,
  waitFor,
} from './support/native-runtime.js';

const CHUNK_BYTES = 64 * 1024;
const STREAM_BYTES = 512 * 1024;
const MAX_PRELOAD_BYTES = 32 * 1024 * 1024;

const EXPIRY_MARGIN_MS = 1500;
const TIMER_EARLY_MARGIN_MS = 20;
const PROCESS_CONTROL_SKIP =
  process.platform === 'darwin' || process.platform === 'linux'
    ? false
    : 'Owned-reader SIGSTOP requires macOS or Linux.';

interface ObservedWrite {
  started: number;
  done: Promise<void>;
  settled: boolean;
}

async function preloadNativeSendWindow(connection: Connection) {
  const chunk = Array<number>(CHUNK_BYTES).fill(48);
  const streams: SendStream[] = [];
  let queuedBytes = 0;
  let streamBytes = STREAM_BYTES;
  let stream: SendStream | undefined;
  while (queuedBytes < MAX_PRELOAD_BYTES) {
    if (!stream || streamBytes >= STREAM_BYTES) {
      stream = await within(connection.openUni());
      streams.push(stream);
      streamBytes = 0;
    }
    const written = await within(stream.write(chunk));
    assert.ok(written > 0 && written <= chunk.length);
    queuedBytes += written;
    streamBytes += written;
    // Below the per-stream allowance: a short write observes connection credit.
    if (written < chunk.length)
      return { streams, queuedBytes, partialBytes: written };
  }
  assert.fail(
    'Native send credit must reach a partial write within the preload budget.',
  );
}

void test(
  'native egress expiry closes a paused unread peer and releases its occupied slot',
  {
    ...NATIVE_TEST_OPTIONS,
    skip: NATIVE_TEST_OPTIONS.skip || PROCESS_CONTROL_SKIP,
    timeout: 40_000,
  },
  async (context) => {
    assert.ok(NATIVE_CAPABILITY.sdk);
    const { SendStream } = NATIVE_CAPABILITY.sdk;
    const lab = await fixture({
      freeBody: Buffer.alloc(HTTP_OVER_IROH.responseBytes, 48),
      holdFirstFreeResponse: true,
    });
    let closePeer = async () => {};
    context.after(async () => {
      try {
        await closePeer();
      } finally {
        await lab.close();
        context.mock.restoreAll();
      }
    });
    const writes: ObservedWrite[] = [];
    const originalWrite = SendStream.prototype.writeAll;
    context.mock.method(
      SendStream.prototype,
      'writeAll',
      function (this: SendStream, data: number[]) {
        const started = performance.now();
        const done = originalWrite.call(this, data);
        if (Buffer.from(data).subarray(0, 5).toString() === 'HTTP/') {
          const record = { started, done, settled: false };
          writes.push(record);
          const settled = () => {
            record.settled = true;
          };
          void done.then(settled, settled);
        }
        return done;
      },
    );
    let target: EndpointAddr | undefined;
    const probe = await lab.client(undefined, async (address) => {
      target = address; // Direct IPv4/IPv6 recovery is deliberately available.
      return address;
    });
    probe.connection.close(HTTP_OVER_IROH.streamCloseCode, []);
    await within(probe.connection.closed());
    await waitFor(() => lab.retired.has(probe.endpoint.id().toString()));
    assert.ok(target);
    const unread = await unreadPeer(target);
    closePeer = unread.close;
    // Handshakes finish outside the measured egress interval.
    const holders: Awaited<ReturnType<typeof lab.client>>[] = [];
    for (let index = 1; index < TRANSPORT_LIMITS.maxEgressConcurrent; index++)
      holders.push(await lab.client());
    await unread.request(0);
    await waitFor(
      () => lab.freeResponseHeld,
      undefined,
      'held free HTTP response',
    );
    assert.equal(writes.length, 0);
    unread.pause(); // Stop native ACKs on every path before occupying send credit.
    const server = lab.serverConnections.find(
      (connection) => connection.remoteId().toString() === unread.nodeId,
    );
    assert.ok(server);
    const preload = await preloadNativeSendWindow(server);
    // Retain all native send handles until cleanup, avoiding implicit stream reset.
    context.after(() => {
      void preload.streams.length;
    });
    assert.ok(preload.queuedBytes > 0 && preload.partialBytes > 0);
    lab.releaseResponse();
    await waitFor(
      () => writes.length === 1,
      undefined,
      'native HTTP write start',
    );
    const blocked = writes[0]!;
    await assert.rejects(
      within(blocked.done, IROH_DEADLINES.egressMs / 10),
      NativeTestDeadlineError,
    );
    assert.equal(blocked.settled, false);
    assert.equal(server.closeReason(), null);
    await delay(
      Math.max(
        0,
        blocked.started + IROH_DEADLINES.egressMs / 2 - performance.now(),
      ),
    );
    const heldStreams: BiStream[] = [];
    const previousStreams = lab.serverStreams;
    await Promise.all(
      holders.map(async (holder) => {
        const stream = await holder.connection.openBi();
        heldStreams.push(stream);
        await stream.send.writeAll([
          ...Buffer.from('POST /inference HTTP/1.1\r\n'),
        ]);
      }),
    );
    await waitFor(
      () => lab.serverStreams === previousStreams + holders.length,
      undefined,
      'all other slots occupied',
    );
    const expiryDeadline =
      blocked.started + IROH_DEADLINES.egressMs + EXPIRY_MARGIN_MS;
    await assert.rejects(
      within(blocked.done, Math.max(1, expiryDeadline - performance.now())),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(
          !(error instanceof NativeTestDeadlineError),
          'The egress guard must cancel the real writer before the fixture deadline.',
        );
        return true;
      },
    );
    assert.ok(
      performance.now() - blocked.started >=
        IROH_DEADLINES.egressMs - TIMER_EARLY_MARGIN_MS,
    );
    assert.notEqual(server.closeReason(), null);
    assert.equal(blocked.settled, true);
    unread.resume();
    await unread.closed();
    await waitFor(
      () => lab.retired.has(unread.nodeId),
      undefined,
      'expired peer retirement',
    );
    const healthy = await lab.transport();
    assert.equal(
      (await within(healthy.exchange(fixtureRequest('healthy-after-expiry'))))
        .status,
      HTTP_STATUS.paymentRequired,
    );
    assert.equal(holders.length + 1, TRANSPORT_LIMITS.maxEgressConcurrent);
    assert.equal(heldStreams.length, holders.length);
    assert.ok(
      holders.every((holder) => holder.connection.closeReason() === null),
      'Other slots must still be held when the freed slot serves a new peer.',
    );
    assert.equal(lab.executions, 0);
    assert.equal(lab.paid.size, 0);
  },
);
