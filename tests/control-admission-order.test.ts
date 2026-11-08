// Native scheduling regressions: client completion cannot stand in for acknowledged server admission.
// Only fresh loopback endpoints and synthetic signed control queries; no HTTP forwarding or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_ALPN, GYBLOS_ALPN } from '@gyblos/protocol/constants';

import { admissionOrder } from './support/native-admission-order';
import {
  holdNativeConnection,
  nativeControlFixture,
} from './support/native-control';
import { NATIVE_CAPABILITY } from './support/native-runtime';
import { within } from './support/test-deadline';

for (const alpn of [GYBLOS_ALPN, CONTROL_ALPN]) {
  void test(
    `held ${alpn} connection waits for the server stream acknowledgement`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async () => {
      const order = admissionOrder(alpn);
      const run = await nativeControlFixture(1000, order.observeSeller);
      let held: Awaited<ReturnType<typeof holdNativeConnection>> | undefined;
      let returned = false;
      const opening = holdNativeConnection(run, alpn, order.onWritten).then(
        (value) => {
          returned = true;
          held = value;
          return value;
        },
      );
      try {
        await within(order.blocked);
        await within(order.written);
        // After write completion, drain JS continuations; no time-based sleep or enlarged deadline.
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          returned,
          false,
          'client write completed before server admission; the holder must still wait',
        );
        assert.deepEqual(order.counts(), { arrivals: 1, admitted: 0 });
        order.release();
        held = await within(opening);
        assert.deepEqual(order.counts(), { arrivals: 1, admitted: 1 });
        const second = await within(
          run.buyer.connect(run.seller.addr(), [...Buffer.from(alpn)]),
        );
        await within(second.closed());
        assert.equal(held.connection.closeReason(), null);
        assert.equal(run.httpRequests, 0);
      } finally {
        order.release();
        await opening.catch(() => undefined);
        await held?.close();
        await run.close();
      }
    },
  );
}
void test(
  'inverted native data completions admit the second connection and correctly refuse the first',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const order = admissionOrder(GYBLOS_ALPN);
    const run = await nativeControlFixture(1000, order.observeSeller);
    const first = await within(
      run.buyer.connect(run.seller.addr(), [...Buffer.from(GYBLOS_ALPN)]),
    );
    const stream = await first.openBi();
    try {
      await stream.send.writeAll([0]);
      await within(order.blocked);
      await within(run.client.getCatalog());
      const second = await within(
        run.buyer.connect(run.seller.addr(), [...Buffer.from(GYBLOS_ALPN)]),
      );
      await within(order.secondAdmitted);
      order.release();
      await within(first.closed());
      assert.equal(second.closeReason(), null);
      assert.deepEqual(order.counts(), { arrivals: 2, admitted: 1 });
      assert.equal(run.httpRequests, 0);
    } finally {
      order.release();
      await stream.send.reset(1n).catch(() => undefined);
      await run.close();
    }
  },
);
