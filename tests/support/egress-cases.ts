import assert from 'node:assert/strict';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { EndpointAddr, SendStream } from '@number0/iroh';

import { HTTP_STATUS, LOCALHOST, P2P } from '@gyblos/config';

import {
  fixture,
  fixtureRequest,
  NativeTestDeadlineError,
  within,
} from './native-fixture.js';
import { unreadPeer } from './native-reader.js';
import {
  NATIVE_CAPABILITY,
  NATIVE_TEST_OPTIONS,
  waitFor,
} from './native-runtime.js';

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
  const listening = Promise.all([
    once(front, 'listening'),
    once(back, 'listening'),
  ]);
  try {
    front.bind(0, LOCALHOST);
    back.bind(0, LOCALHOST);
    await listening;
  } catch (error) {
    for (const socket of [front, back]) {
      try {
        socket.close();
      } catch (closeError) {
        if (
          (closeError as NodeJS.ErrnoException).code !==
          'ERR_SOCKET_DGRAM_NOT_RUNNING'
        )
          throw closeError;
      }
    }
    await listening.catch(() => undefined);
    throw error;
  }
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
    'native egress expiry closes a paused unread peer and releases its occupied slot',
    {
      ...NATIVE_TEST_OPTIONS,
      skip: NATIVE_TEST_OPTIONS.skip || PROCESS_CONTROL_SKIP,
      timeout: 40_000,
    },
    async (context) => {
      assert.ok(NATIVE_CAPABILITY.sdk);
      const { SendStream } = NATIVE_CAPABILITY.sdk;
      let windowTime = 0;
      context.mock.method(Date, 'now', () => windowTime);
      const path = await stalledReturnPath();
      let closeLab = async () => {},
        closePeer = async () => {};
      context.after(async () => {
        path.resume();
        try {
          await closePeer();
        } finally {
          try {
            await closeLab();
          } finally {
            path.close();
            context.mock.restoreAll();
          }
        }
      });
      const lab = await fixture({
        freeBody: Buffer.alloc(P2P.responseBytes, 48),
      });
      closeLab = lab.close;
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
      // Obtain only the seller's loopback descriptor; retire this unfunded probe.
      let target: EndpointAddr | undefined;
      const probe = await lab.client(undefined, async (address) => {
        target = await path.address(address);
        return address;
      });
      probe.connection.close(P2P.streamCloseCode, []);
      await within(probe.connection.closed());
      await waitFor(() => lab.retired.has(probe.endpoint.id().toString()));
      assert.ok(target);
      const unread = await unreadPeer(target);
      closePeer = unread.close;
      let blocked: ObservedWrite | undefined;
      // Real unread receive handles stay in the owned child. Admission Date.now
      // advances across two quotas; native clocks and all deadline timers stay real.
      for (let index = 0; index < P2P.requestsPerWindow * 2; index++) {
        if (index > 0 && index % P2P.requestsPerWindow === 0)
          windowTime += P2P.rateWindowMs;
        await unread.request(index);
        await waitFor(
          () => writes.length > index,
          undefined,
          'native response write start',
        );
        const record = writes[index]!;
        try {
          await within(record.done, P2P.egressMs / 10);
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
      unread.pause(); // Only the owned buyer child; prevents IPv6 path recovery too.
      assert.equal(blocked.settled, false);
      const server = lab.serverConnections.find(
        (connection) => connection.remoteId().toString() === unread.nodeId,
      );
      assert.ok(server);
      assert.equal(server.closeReason(), null);
      await delay(
        Math.max(0, blocked.started + P2P.egressMs / 2 - performance.now()),
      );
      // Seven independent incomplete ingress streams retain every other slot.
      const holders: Awaited<ReturnType<typeof lab.client>>[] = [];
      const previousStreams = lab.serverStreams;
      for (let index = 1; index < P2P.maxEgressConcurrent; index++) {
        const holder = await lab.client();
        holders.push(holder);
        const stream = await holder.connection.openBi();
        await stream.send.writeAll([
          ...Buffer.from('POST /inference HTTP/1.1\r\n'),
        ]);
      }
      await waitFor(
        () => lab.serverStreams === previousStreams + holders.length,
        undefined,
        'all other slots occupied',
      );
      const expiryDeadline = blocked.started + P2P.egressMs + EXPIRY_MARGIN_MS;
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
          P2P.egressMs - TIMER_EARLY_MARGIN_MS,
      );
      assert.notEqual(server.closeReason(), null);
      assert.equal(blocked.settled, true);
      path.resume();
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
      assert.equal(holders.length + 1, P2P.maxEgressConcurrent);
      assert.ok(
        holders.every((holder) => holder.connection.closeReason() === null),
        'Other slots must still be held when the freed slot serves a new peer.',
      );
      assert.equal(lab.executions, 0);
      assert.equal(lab.paid.size, 0);
    },
  );
}
