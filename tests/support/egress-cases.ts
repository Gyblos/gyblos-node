import assert from 'node:assert/strict';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  BiStream,
  EndpointAddr,
  RecvStream,
  SendStream,
} from '@number0/iroh';

import { HTTP_STATUS, LOCALHOST, P2P } from '@gyblos/config';

import {
  bytes,
  fixture,
  fixtureRequest,
  NativeTestDeadlineError,
  within,
} from './native-fixture.js';
import {
  NATIVE_CAPABILITY,
  NATIVE_TEST_OPTIONS,
  waitFor,
} from './native-runtime.js';

const EXPIRY_MARGIN_MS = 1500;
const TIMER_EARLY_MARGIN_MS = 20;

interface ObservedWrite {
  started: number;
  done: Promise<void>;
  settled: boolean;
}

// Only owned loopback UDP sockets are affected. No host firewall or relay changes.
async function stalledReturnPath() {
  assert.ok(NATIVE_CAPABILITY.sdk);
  const { EndpointAddr } = NATIVE_CAPABILITY.sdk;
  const front = createSocket('udp4'),
    back = createSocket('udp4');
  let peer: RemoteInfo | undefined,
    sellerPort = 0,
    paused = false;
  let lastPacket: Buffer | undefined;
  front.on('message', (packet, remote) => {
    peer = remote;
    back.send(packet, sellerPort, LOCALHOST);
  });
  back.on('message', (packet) => {
    if (paused) lastPacket = packet;
    else if (peer) front.send(packet, peer.port, peer.address);
  });
  front.bind(0, LOCALHOST);
  back.bind(0, LOCALHOST);
  await Promise.all([once(front, 'listening'), once(back, 'listening')]);
  return {
    async address(seller: EndpointAddr) {
      const address = seller
        .directAddresses()
        .find((value) => value.startsWith(LOCALHOST + ':'));
      assert.ok(address, 'A loopback-only IPv4 seller address is required.');
      sellerPort = Number(address.split(':').at(-1));
      return new EndpointAddr(seller.id(), null, [
        LOCALHOST + ':' + front.address().port,
      ]);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      if (lastPacket && peer) front.send(lastPacket, peer.port, peer.address);
      lastPacket = undefined;
    },
    close() {
      front.close();
      back.close();
    },
  };
}

export function registerEgressCases() {
  test(
    'native egress expiry closes an unread stalled peer and releases its occupied slot',
    { ...NATIVE_TEST_OPTIONS, timeout: 40_000 },
    async (context) => {
      assert.ok(NATIVE_CAPABILITY.sdk);
      const { SendStream } = NATIVE_CAPABILITY.sdk;
      // Advance admission-window time only; native I/O and egress/ingress timers stay real.
      let windowTime = 0;
      context.mock.method(Date, 'now', () => windowTime);
      const path = await stalledReturnPath();
      let closeLab = async () => {};
      context.after(async () => {
        path.resume();
        try {
          await closeLab();
        } finally {
          path.close();
          context.mock.restoreAll();
        }
      });
      const lab = await fixture({
        freeBody: Buffer.alloc(P2P.responseBytes, 48),
      });
      closeLab = lab.close;
      const retained: { stream: BiStream; receiver: RecvStream }[] = [];
      const writes: ObservedWrite[] = [];
      const originalWrite = SendStream.prototype.writeAll;
      let returnPathPaused = false;
      context.mock.method(
        SendStream.prototype,
        'writeAll',
        function (this: SendStream, data: number[]) {
          const response =
            Buffer.from(data).subarray(0, 5).toString() === 'HTTP/';
          if (response && !returnPathPaused) {
            path.pause();
            returnPathPaused = true;
          }
          const done = originalWrite.call(this, data);
          if (response) {
            const record = { started: performance.now(), done, settled: false };
            writes.push(record);
            // Observe the original promise without replacing or delaying native writes.
            void done.then(
              () => {
                record.settled = true;
              },
              () => {
                record.settled = true;
              },
            );
          }
          return done;
        },
      );
      {
        const unread = await lab.client(undefined, path.address);
        unread.connection.setReceiveWindow(1n);
        let blocked: ObservedWrite | undefined;
        // The binding can enqueue a complete response without an application read.
        // Retain all receive handles and fill its real send buffer across two windows.
        for (let index = 0; index < P2P.requestsPerWindow * 2; index++) {
          if (index > 0 && index % P2P.requestsPerWindow === 0)
            windowTime += P2P.rateWindowMs;
          const stream = await within(unread.connection.openBi());
          const receiver = stream.recv;
          retained.push({ stream, receiver });
          await stream.send.writeAll([...bytes('unread-' + index)]);
          await stream.send.finish();
          await waitFor(
            () => writes.length > index,
            undefined,
            'native response write start',
          );
          const record = writes[index]!;
          try {
            await within(record.done, P2P.egressMs / 50);
          } catch (error) {
            if (!(error instanceof NativeTestDeadlineError)) throw error;
            blocked = record;
            break;
          }
        }
        assert.ok(
          blocked,
          'The real native write must block within the bounded warm-up.',
        );
        assert.equal(blocked.settled, false);
        const server = lab.serverConnections[0];
        assert.ok(server);
        assert.equal(server.closeReason(), null);
        // Stage seven incomplete ingress streams halfway through the blocked egress.
        // They keep every other slot occupied beyond this egress deadline.
        await delay(
          Math.max(0, blocked.started + P2P.egressMs / 2 - performance.now()),
        );
        const holders: Awaited<ReturnType<typeof lab.client>>[] = [];
        const previousStreams = lab.serverStreams;
        for (let index = 1; index < P2P.maxEgressConcurrent; index++) {
          const holder = await lab.client();
          holders.push(holder);
          const stream = await holder.connection.openBi();
          retained.push({ stream, receiver: stream.recv });
          await stream.send.writeAll([
            ...Buffer.from('POST /inference HTTP/1.1\r\n'),
          ]);
        }
        await waitFor(
          () => lab.serverStreams === previousStreams + holders.length,
          undefined,
          'all other egress slots occupied by ingress',
        );
        // Await the writer before adding any extra native closed() waiters.
        await assert.rejects(
          within(
            blocked.done,
            Math.max(
              1,
              blocked.started +
                P2P.egressMs +
                EXPIRY_MARGIN_MS -
                performance.now(),
            ),
          ),
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
            P2P.egressMs - TIMER_EARLY_MARGIN_MS,
        );
        assert.notEqual(server.closeReason(), null);
        assert.equal(blocked.settled, true);
        path.resume();
        await within(unread.connection.closed());
        await waitFor(
          () => lab.retired.has(unread.endpoint.id().toString()),
          undefined,
          'expired connection retirement',
        );
        const healthy = await lab.transport();
        assert.equal(
          (
            await within(
              healthy.exchange(fixtureRequest('healthy-after-egress-expiry')),
            )
          ).status,
          HTTP_STATUS.paymentRequired,
        );
        assert.equal(holders.length + 1, P2P.maxEgressConcurrent);
        assert.ok(
          holders.every((holder) => holder.connection.closeReason() === null),
          'Other ingress slots must still be held when the freed slot serves a new peer.',
        );
        assert.equal(lab.executions, 0);
        assert.equal(lab.paid.size, 0);
        assert.ok(retained.length > holders.length);
      }
    },
  );
}
