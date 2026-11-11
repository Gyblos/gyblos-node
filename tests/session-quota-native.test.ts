// Native loopback sessions prove inference quota cannot strand original financial approvals or closure.
// Financial services and engines are synthetic; no RPC, funded wallet or external relay is used.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TRANSPORT_LIMITS, type TransportLimits } from '@gyblos/config';
import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  BatchChannelError,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { createBatchChannelClient } from '@gyblos/transport-iroh/batch-client';
import { HTTP_OVER_IROH } from '@gyblos/transport-iroh/constants';
import { serveIroh } from '@gyblos/transport-iroh/iroh-server';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';
import { endpoint, within } from './support/native-fixture';
import { NATIVE_TEST_OPTIONS } from './support/native-runtime';

async function fixture(limits: TransportLimits) {
  const seller = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
  const peer = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
  const rig = await sessionRig({
    buyerNodeId: peer.id().toString(),
    sellerNodeId: seller.id().toString(),
    transaction: 'ab'.repeat(32),
  });
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const service = createSellerBatchSession({
    session: rig.seller(),
    terms: rig.terms,
    offers: () => [offers.live],
    now: rig.now,
  });
  const calls: BatchChannelRequest['method'][] = [];
  let loseApproval = false;
  const server = serveIroh(
    seller,
    'http://127.0.0.1:1',
    false,
    undefined,
    undefined,
    limits,
    undefined,
    undefined,
    {
      async exchange(request, ...args) {
        calls.push(request.method);
        const result = await service.exchange(request, ...args);
        if (loseApproval && request.method === BATCH_METHODS.APPROVE) {
          loseApproval = false;
          throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
        }
        return result;
      },
    },
  );
  const connect = () =>
    createBuyerBatchSession({
      endpoint: peer,
      destination: seller.addr(),
      terms: rig.terms,
      buyer: rig.buyer,
      meter: offers.meter,
      now: rig.now,
      unresolved: async () => false,
      verify: async () => {},
      observe: rig.sellerOptions.observe,
    });
  const buyers = [connect()];
  return {
    rig,
    peer,
    seller,
    offers,
    calls,
    buyer: () => buyers.at(-1)!,
    loseApproval: () => {
      loseApproval = true;
    },
    async reconnect() {
      await buyers.at(-1)!.disconnect();
      await buyers.at(-1)!.settled();
      buyers.push(connect());
    },
    async close() {
      for (const buyer of buyers) {
        await buyer.disconnect();
        await buyer.settled();
      }
      await peer.close();
      await server.close();
      await rig.dispose();
    },
  };
}

for (const global of [false, true])
  void test(
    `native session ${global ? 'global' : 'peer'} quota counts only execution, including the last approval`,
    NATIVE_TEST_OPTIONS,
    async (t) => {
      const f = await fixture({
        ...TRANSPORT_LIMITS,
        requestsPerWindow: global ? 2 : 1,
        globalRequestsPerWindow: global ? 1 : 2,
      });
      t.after(f.close);
      t.mock.method(Date, 'now', f.rig.now);
      const result = await within(
        f.buyer().execute(await f.offers.quote(1), f.offers.input),
      );
      assert.equal(result.text, 'ok!');
      assert.equal(f.offers.generations(), 1);
      assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '40');
      // A fresh execution is still denied; the service must never see its prompt.
      await assert.rejects(
        within(f.buyer().execute(await f.offers.quote(2), f.offers.input)),
        { code: SESSION_CODES.LIMIT, remote: true },
      );
      assert.equal(f.offers.generations(), 1);
      assert.equal(
        f.calls.filter((method) => method === BATCH_METHODS.EXECUTE).length,
        1,
      );
      f.rig.time(f.rig.now() + 1000);
      assert.equal((await within(f.buyer().status())).cumulativeAtomic, '40');
      const settlement = await within(f.buyer().close());
      assert.equal(settlement.chargedAtomic, '40');
      assert.equal(settlement.refundedAtomic, '960');
      assert.deepEqual(f.rig.calls, ['deposit', 'refund']);
    },
  );

void test(
  'native exhausted session reconnect recovers the original lost ACK without replaying a prompt',
  NATIVE_TEST_OPTIONS,
  async (t) => {
    const f = await fixture({
      ...TRANSPORT_LIMITS,
      requestsPerWindow: 1,
      globalRequestsPerWindow: 1,
    });
    t.after(f.close);
    t.mock.method(Date, 'now', f.rig.now);
    f.loseApproval();
    await assert.rejects(
      within(f.buyer().execute(await f.offers.quote(1), f.offers.input)),
      { code: SESSION_CODES.UNAVAILABLE },
    );
    assert.equal(f.offers.generations(), 1);
    assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '40');
    f.rig.time(f.rig.now() + 1000);
    await f.reconnect();
    assert.equal(await within(f.buyer().recoverApproval()), true);
    assert.equal(f.offers.generations(), 1);
    assert.equal(
      f.calls.filter((method) => method === BATCH_METHODS.APPROVE).length,
      2,
    );
    const settlement = await within(f.buyer().close());
    assert.equal(settlement.chargedAtomic, '40');
    assert.equal(settlement.refundedAtomic, '960');
    assert.deepEqual(f.rig.calls, ['deposit', 'refund']);
  },
);

void test(
  'native session query burst stays bounded without consuming inference quota',
  NATIVE_TEST_OPTIONS,
  async (t) => {
    let time = 0;
    t.mock.method(performance, 'now', () => time);
    const f = await fixture(TRANSPORT_LIMITS);
    t.after(f.close);
    t.mock.method(Date, 'now', f.rig.now);
    await within(f.buyer().execute(await f.offers.quote(1), f.offers.input));
    const initial = f.calls.length;
    for (let index = initial; index < CONTROL_CAPACITY.peerBurst; index++)
      await within(f.buyer().status());
    assert.equal(f.calls.length, CONTROL_CAPACITY.peerBurst);
    await assert.rejects(within(f.buyer().status()), {
      code: PAID_EXECUTION_CODES.INTERNAL,
      remote: false,
      sent: true,
    });
    assert.equal(f.calls.length, CONTROL_CAPACITY.peerBurst);
    time += CONTROL_CAPACITY.millisecondsPerSecond / CONTROL_CAPACITY.peerRate;
    assert.equal((await within(f.buyer().status())).cumulativeAtomic, '40');
    assert.equal(f.offers.generations(), 1);
  },
);

void test(
  'native malformed session streams consume query rate across reconnections, not inference quota',
  NATIVE_TEST_OPTIONS,
  async (t) => {
    let time = 0;
    t.mock.method(performance, 'now', () => time);
    const f = await fixture(TRANSPORT_LIMITS);
    t.after(f.close);
    t.mock.method(Date, 'now', f.rig.now);
    for (let index = 0; index < CONTROL_CAPACITY.peerBurst; index++) {
      const connection = await within(
        f.peer.connect(f.seller.addr(), [...Buffer.from(BATCH_CHANNEL.alpn)]),
      );
      try {
        const stream = await within(connection.openBi());
        await stream.send.writeAll([
          ...encodeControlFrame({ invalid: true }, BATCH_CHANNEL.requestBytes),
        ]);
        await stream.send.finish();
        await within(connection.closed());
      } finally {
        connection.close(HTTP_OVER_IROH.streamCloseCode, []);
      }
    }
    assert.equal(f.calls.length, 0);
    const client = createBatchChannelClient(
      f.peer,
      f.seller.addr(),
      f.seller.id().toString(),
    );
    t.after(async () => {
      await client.close();
      await client.settled();
    });
    const request = {
      version: BATCH_CHANNEL.version,
      requestId: 'ab'.repeat(16),
      method: BATCH_METHODS.SNAPSHOT,
      params: { channelId: '1'.repeat(32) },
    };
    await assert.rejects(within(client.exchange(request)), {
      code: PAID_EXECUTION_CODES.INTERNAL,
      remote: false,
      sent: true,
    });
    assert.equal(f.calls.length, 0);
    time += CONTROL_CAPACITY.millisecondsPerSecond / CONTROL_CAPACITY.peerRate;
    await assert.rejects(within(client.exchange(request)), {
      code: SESSION_CODES.BINDING,
      remote: true,
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.offers.generations(), 0);
    assert.deepEqual(f.rig.calls, []);
  },
);
