// Native scheduling regressions: client completion cannot stand in for acknowledged server admission.
// Only fresh loopback endpoints and synthetic signed control queries; no HTTP forwarding or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_ALPN, GYBLOS_ALPN } from '@gyblos/protocol/constants';

import {
  admissionOrder,
  invertedDataAdmission,
} from './support/native-admission-order';
import {
  holdNativeConnection,
  nativeControlFixture,
} from './support/native-control';
import { NATIVE_CAPABILITY } from './support/native-runtime';
import { within } from './support/test-deadline';

for (const alpn of [GYBLOS_ALPN, CONTROL_ALPN] as const) {
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
      // Cleanup awaits this promise; observe an early rejection while waiting on native milestones.
      void opening.catch(() => undefined);
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
    await invertedDataAdmission(run, order);
  },
);
for (const stage of ['connect', 'openBi'] as const) {
  void test(
    `inverted native ${stage} setup failure releases the gate and closes the fixture`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async () => {
      const order = admissionOrder(GYBLOS_ALPN);
      const run = await nativeControlFixture(1000, order.observeSeller);
      const close = run.close.bind(run);
      const failure = new Error('Synthetic admission setup failure');
      let closed = false;
      let released = false;
      let releaseBeforeClose = false;
      const release = order.release;
      order.release = () => {
        released = true;
        release();
      };
      run.close = async () => {
        releaseBeforeClose = released;
        await close();
        closed = true;
      };
      try {
        const connect = run.buyer.connect.bind(run.buyer);
        run.buyer.connect = async (...args) => {
          if (stage === 'connect') throw failure;
          const connection = await connect(...args);
          connection.openBi = async () => {
            throw failure;
          };
          return connection;
        };
        await assert.rejects(
          invertedDataAdmission(run, order),
          (error: unknown) => error === failure,
        );
        assert.equal(
          closed,
          true,
          'Setup failure must close the already-created fixture',
        );
        assert.equal(
          releaseBeforeClose,
          true,
          'Release held native work before closing the fixture',
        );
        await within(run.server.running);
      } finally {
        // Test-owned cleanup also runs when probing a mutation that removes scenario cleanup.
        order.release();
        if (!closed) await close();
      }
    },
  );
}
