// Single permitted-peer daemon lifecycle over synthetic finance; preparation cannot allocate its slot.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startSellerSessions } from '@gyblos/node/seller-sessions';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';

void test('seller startup prepares statelessly, then keeps one proven financial session after OPEN', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  let creates = 0;
  const host = await startSellerSessions({
    buyerNodeId: rig.terms.buyerNodeId,
    backend: {
      inspect: async () => undefined,
      create: async () => {
        creates++;
        return rig.seller();
      },
    },
    owner: rig.terms.owner,
    nodeId: rig.terms.sellerNodeId,
    description: { ...rig.terms },
    offers: () => [offers.live],
    now: rig.now,
  });
  assert.ok(host);
  t.after(host.close);
  const quote = await offers.quote(1);
  const request = parseBatchChannelRequest({
    version: BATCH_CHANNEL.version,
    requestId: '12'.repeat(16),
    method: BATCH_METHODS.PREPARE,
    params: { quote, terms: rig.terms },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    await host.service.exchange(request, rig.terms.buyerNodeId, signal),
    { terms: rig.terms },
  );
  assert.equal(creates, 0);
  assert.deepEqual(rig.calls, []);
  await assert.rejects(
    host.service.exchange(request, '56'.repeat(32), signal),
    { code: PAID_EXECUTION_CODES.PEER },
  );
  assert.equal(creates, 0);
  const payload = await rig.buyer.open();
  await host.service.exchange(
    parseBatchChannelRequest({
      version: BATCH_CHANNEL.version,
      requestId: '34'.repeat(16),
      method: BATCH_METHODS.OPEN,
      params: { quote, terms: rig.terms, payload },
    }),
    rig.terms.buyerNodeId,
    signal,
  );
  assert.equal(creates, 1);
  assert.deepEqual(rig.calls, ['deposit']);
  assert.equal(offers.generations(), 0);
});

for (const expires of ['quote', 'session'] as const) {
  void test(`unassigned seller preparation rejects ${expires} expiry during crypto without allocating a session`, async (t) => {
    const rig = await sessionRig();
    t.after(rig.dispose);
    const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
    let creates = 0;
    const host = await startSellerSessions({
      buyerNodeId: rig.terms.buyerNodeId,
      owner: rig.terms.owner,
      nodeId: rig.terms.sellerNodeId,
      description: rig.terms,
      now: rig.now,
      offers: () => [offers.live],
      backend: {
        inspect: async () => undefined,
        create: async () => {
          creates++;
          return rig.seller();
        },
      },
    });
    t.after(host.close);
    const quote = await offers.quote(1);
    const terms =
      expires === 'session'
        ? { ...rig.terms, expiresAt: rig.now() + 1 }
        : rig.terms;
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    t.mock.method(
      crypto.subtle,
      'verify',
      async (...args: Parameters<typeof verify>) => {
        const valid = await verify(...args);
        rig.time(expires === 'quote' ? quote.offer.expiresAt : terms.expiresAt);
        return valid;
      },
    );
    await assert.rejects(
      host.service.exchange(
        parseBatchChannelRequest({
          version: BATCH_CHANNEL.version,
          requestId: '12'.repeat(16),
          method: BATCH_METHODS.PREPARE,
          params: { quote, terms },
        }),
        terms.buyerNodeId,
        new AbortController().signal,
      ),
      {
        code:
          expires === 'quote'
            ? PAID_EXECUTION_CODES.EXPIRED
            : SESSION_CODES.LIMIT,
      },
    );
    assert.equal(creates, 0);
    assert.deepEqual(rig.calls, []);
  });
}
