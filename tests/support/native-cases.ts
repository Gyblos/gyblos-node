// Owns offline native cases regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { P2P } from '@gyblos/config';
import { encodeRequest } from '@gyblos/transport-iroh/wire';

import {
  bytes,
  exchange,
  fixture,
  fixtureRequest,
  NativeTestDeadlineError,
  within,
} from './native-fixture.js';
import { NATIVE_TEST_OPTIONS, waitFor } from './native-runtime.js';

const TIMEOUT = 20_000;

async function rejectsBeforeDeadline(operation: Promise<unknown>) {
  await assert.rejects(within(operation), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(
      !(error instanceof NativeTestDeadlineError),
      'The peer must reject the request before the fixture deadline.',
    );
    return true;
  });
}

export function registerNativeCases() {
  void test(
    'native priority1: reset/half-close incomplete input and a closed response preserve healthy-peer access',
    { ...NATIVE_TEST_OPTIONS, timeout: TIMEOUT },
    async () => {
      const lab = await fixture();
      try {
        const { connection } = await lab.client();
        const stream = await connection.openBi();
        await stream.send.writeAll([
          ...Buffer.from('POST /inference HTTP/1.1\r\n'),
        ]);
        await stream.send.reset(1n);
        await within(connection.closed());
        assert.equal(lab.accepted.length, 0);
        const healthy = await lab.transport();
        assert.equal(
          (await healthy.exchange(fixtureRequest('healthy-after-reset')))
            .status,
          402,
        );
        const short = await lab.client();
        const request = fixtureRequest('hold-after-simulated-settlement');
        request.headers['payment-signature'] =
          'synthetic-authorization-not-a-signature';
        const paidStream = await short.connection.openBi();
        await paidStream.send.writeAll([...encodeRequest(request)]);
        await paidStream.send.finish();
        await within(lab.paidReached);
        short.connection.close(1n, []);
        await within(short.connection.closed());
        lab.releaseResponse();
        assert.equal(
          (await healthy.exchange(fixtureRequest('healthy-after-disconnect')))
            .status,
          402,
        );
        assert.equal(lab.executions, 1);
        assert.equal([...lab.paid.values()][0]?.claims, 1);
      } finally {
        await lab.close();
      }
    },
  );

  void test(
    'native priority2: valid fragmentation is exact; truncated/ambiguous/oversized frames never reach origin',
    { ...NATIVE_TEST_OPTIONS, timeout: TIMEOUT },
    async () => {
      const lab = await fixture();
      try {
        const valid = await lab.client();
        assert.equal(
          (await within(exchange(valid.connection, bytes('fragmented'), 17)))
            .status,
          402,
        );
        assert.deepEqual(lab.accepted, ['fragmented']);
        const encoded = bytes('invalid');
        const malformed = [
          encoded.subarray(0, encoded.length - 1),
          Buffer.from(
            'POST /inference HTTP/1.1\r\ncontent-type: application/json\r\ncontent-length: 2\r\ncontent-length: 2\r\n\r\n{}',
          ),
          Buffer.concat([
            Buffer.from(
              `POST /inference HTTP/1.1\r\ncontent-type: application/json\r\ncontent-length: ${P2P.bodyBytes + 1}\r\n\r\n`,
            ),
            Buffer.alloc(P2P.bodyBytes + 1),
          ]),
        ];
        for (const frame of malformed) {
          const client = await lab.client();
          await rejectsBeforeDeadline(exchange(client.connection, frame, 5));
          await within(client.connection.closed());
          assert.notEqual(client.connection.closeReason(), null);
        }
        assert.deepEqual(lab.accepted, ['fragmented']);
        assert.equal(
          (await within(exchange(valid.connection, bytes('healthy')))).status,
          402,
        );
      } finally {
        await lab.close();
      }
    },
  );

  void test(
    'native priority3: remote receipt loss poisons the live buyer; a new transport does not execute the duplicate',
    { ...NATIVE_TEST_OPTIONS, timeout: TIMEOUT },
    async () => {
      const lab = await fixture({ dropPaidResponse: true });
      try {
        const client = await lab.transport();
        const request = fixtureRequest('remote-simulated-receipt-loss');
        request.headers['payment-signature'] =
          'synthetic-authorization-not-a-signature';
        await rejectsBeforeDeadline(client.exchange(request));
        await within(lab.paidReached);
        const before = lab.accepted.length;
        await assert.rejects(
          within(client.exchange(request)),
          /Transport is uncertain; reconcile before reconnecting/,
        );
        assert.equal(
          lab.accepted.length,
          before,
          'An uncertain live transport must refuse an explicit subsequent exchange',
        );
        assert.equal(lab.executions, 1);
        const reconnected = await lab.transport();
        const duplicate = await within(reconnected.exchange(request));
        assert.equal(
          duplicate.status,
          409,
          'Only the synthetic backend classifies duplicate authorization',
        );
        assert.equal(lab.executions, 1);
        assert.equal([...lab.paid.values()][0]?.claims, 1);
      } finally {
        await lab.close();
      }
    },
  );

  void test(
    'native priority4: multiple NodeIds behind one IP stay usable despite another NodeId opening duplicate connections',
    { ...NATIVE_TEST_OPTIONS, timeout: TIMEOUT },
    async () => {
      const lab = await fixture();
      try {
        const first = await lab.transport();
        const second = await lab.transport();
        const secret = [...randomBytes(P2P.nodeSecretBytes)];
        const duplicates: Awaited<ReturnType<typeof lab.client>>[] = [];
        for (let index = 0; index < P2P.maxConnections; index++) {
          try {
            duplicates.push(await lab.client(secret));
          } catch {
            /* Admission can refuse excess connections. */
          }
        }
        await waitFor(
          () =>
            duplicates.filter(
              (client) => client.connection.closeReason() === null,
            ).length <= P2P.maxPeerConnections,
          undefined,
          'duplicate-connection admission decisions',
        );
        assert.equal(
          (await within(first.exchange(fixtureRequest('same-ip-first'))))
            .status,
          402,
        );
        assert.equal(
          (await within(second.exchange(fixtureRequest('same-ip-second'))))
            .status,
          402,
        );
        const third = await lab.transport();
        assert.equal(
          (await within(third.exchange(fixtureRequest('same-ip-third'))))
            .status,
          402,
        );
        const live = duplicates.filter(
          (client) => client.connection.closeReason() === null,
        );
        assert.ok(
          live.length <= 1,
          'A NodeId owns at most one established connection',
        );
      } finally {
        await lab.close();
      }
    },
  );
}
