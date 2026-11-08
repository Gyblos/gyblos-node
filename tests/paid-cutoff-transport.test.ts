// Exercises payment cutoff through the product service and transport with a blocked native write.
// Only synthetic frames and payment ports are used; no sockets, engine process or chain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { recountedMeter } from '@gyblos/node/free-meter';
import {
  decodePaidStreamEvent,
  encodePaidExecutionRequest,
} from '@gyblos/protocol/paid-stream';
import { PAID_STREAM } from '@gyblos/protocol/paid/constants';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';
import { servePaidExecutionStream } from '@gyblos/transport-iroh/paid-server';

import { paidSellerFixture } from './support/paid-seller';

for (const text of ['Hi', 'x'.repeat(PAID_STREAM.deltaBytes + 1)]) {
  void test(
    `claim cutoff closes and drains an in-flight ${text.length > PAID_STREAM.deltaBytes ? 'multi-chunk' : 'single-chunk'} delta without a terminal`,
    { timeout: 15000 },
    async (context) => {
      const seller = await paidSellerFixture({
        meter: recountedMeter({ input: () => 4, count: () => 1 }),
      });
      let now = seller.options.now();
      seller.options.now = () => now;
      seller.payment.control.claimUntil = now + 70;
      seller.setScript({ deltas: [text] });
      const request = await seller.request();
      const frame = encodePaidExecutionRequest(request);
      let offset = 0;
      let started = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      let unblock = () => {};
      const held = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const frames: ReturnType<typeof decodePaidStreamEvent>[] = [];
      let closed = 0;
      let released = 0;
      let finished = 0;
      const stream: ControlStream = {
        recv: {
          async readExact(size) {
            const part = frame.subarray(offset, offset + size);
            offset += size;
            return [...part];
          },
          async read() {
            return [];
          },
        },
        send: {
          async writeAll(bytes) {
            frames.push(decodePaidStreamEvent(Uint8Array.from(bytes)));
            started();
            await held;
          },
          async finish() {
            finished++;
          },
        },
      };
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const running = servePaidExecutionStream(
        stream,
        seller.service,
        request.quote.offer.buyerNodeId,
        () => {
          closed++;
        },
        new AbortController().signal,
        () => () => {
          released++;
        },
      );
      context.after(async () => {
        unblock();
        await running;
      });
      await entered;
      now += 20;
      context.mock.timers.tick(20);
      await yieldTurn();
      assert.equal(seller.payment.calls.settle.length, 1);
      assert.equal(seller.payment.calls.settle[0]?.chargedAtomic, '0');
      assert.equal(
        closed,
        1,
        'an unacknowledged delta cannot precede a fabricated terminal',
      );
      assert.equal(released, 0, 'the native write still owns the lease');
      unblock();
      await running;
      assert.equal(released, 1);
      assert.equal(finished, 0);
      assert.deepEqual(
        frames.map((event) => event.type),
        [PAID_STREAM.events.DELTA],
      );
      assert.equal(seller.engineCalls.length, 1);
    },
  );
}
