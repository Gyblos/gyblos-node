// Exercises control ALPN dispatch through native Iroh admission on loopback when available.
// Ephemeral unfunded identities only: no relay, engine, HTTP forwarding or payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_ALPN,
  CONTROL_CODES,
  CONTROL_PAID_ALPN,
  GYBLOS_ALPN,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import {
  nativeControlFixture as fixture,
  holdNativeConnection,
} from './support/native-control';
import { within } from './support/native-fixture';
import { NATIVE_CAPABILITY } from './support/native-runtime';

void test(
  'native control fetches catalog/presence and exact quote while paid HTTP v2 stays unsupported',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const run = await fixture();
    try {
      await within(run.client.getCatalog());
      await within(run.client.getPresence());
      const quote = await within(run.client.requestOffer(run.request.params));
      assert.equal(quote.offer.buyerNodeId, run.buyer.id().toString());
      assert.equal(quote.offer.reasoning, REASONING_LEVELS.OFF);
      assert.equal(quote.offer.protocol, CONTROL_PAID_ALPN);
      assert.equal(run.httpRequests, 0);
      run.setReadiness({ busy: true });
      await assert.rejects(run.client.requestOffer(run.request.params), {
        code: CONTROL_CODES.BUSY,
      });
      await assert.rejects(
        run.client.requestOffer({
          ...run.request.params,
          reasoning: REASONING_LEVELS.HIGH,
        }),
        { code: CONTROL_CODES.LEVEL },
      );
      await assert.rejects(
        within(
          run.buyer.connect(run.seller.addr(), [
            ...Buffer.from(CONTROL_PAID_ALPN),
          ]),
        ),
      );
    } finally {
      await run.close();
    }
  },
);
void test(
  'native NodeId admission allows one control and one data connection; a second data connection is refused',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (context) => {
    const run = await fixture();
    let held: Awaited<ReturnType<typeof holdNativeConnection>> | undefined;
    let phase = 'first data stream acknowledgement';
    try {
      held = await holdNativeConnection(run, GYBLOS_ALPN);
      // A server-acknowledged data lease coexists with this peer's separate control lease.
      phase = 'control catalog with held data lease';
      await within(run.client.getCatalog());
      phase = 'second data connection';
      const second = await within(
        run.buyer.connect(run.seller.addr(), [...Buffer.from(GYBLOS_ALPN)]),
      );
      phase = 'second data refusal';
      await within(second.closed());
      assert.equal(held.connection.closeReason(), null);
      phase = 'complete';
    } finally {
      context.diagnostic(`Native admission phase: ${phase}`);
      try {
        await held?.close();
      } finally {
        await run.close();
      }
    }
  },
);
void test(
  'native NodeId admission still refuses a second concurrent control connection from the same peer',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const run = await fixture();
    let held: Awaited<ReturnType<typeof holdNativeConnection>> | undefined;
    try {
      held = await holdNativeConnection(run, CONTROL_ALPN);
      const second = await within(
        run.buyer.connect(run.seller.addr(), [...Buffer.from(CONTROL_ALPN)]),
      );
      await within(second.closed());
      assert.equal(held.connection.closeReason(), null);
    } finally {
      try {
        await held?.close();
      } finally {
        await run.close();
      }
    }
  },
);
void test(
  'native oversized and slow control frames close connections before any HTTP forwarding',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    for (const bytes of [[0, 1, 0, 0], [0]]) {
      const run = await fixture(40);
      try {
        const connection = await within(
          run.buyer.connect(run.seller.addr(), [...Buffer.from(CONTROL_ALPN)]),
        );
        const stream = await connection.openBi();
        await stream.send.writeAll(bytes);
        await within(connection.closed());
      } finally {
        await run.close();
      }
    }
  },
);
