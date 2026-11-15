// Shared seller routing keeps one foreground turn and preserves financial recovery after pilot removal.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { startSellerSessionHost } from '@gyblos/node/seller-session-directory';
import type { BatchSellerRegistry } from '@gyblos/payments-upto/batch-session';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  type PaymentSessionTerms,
} from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { batchOfferFixture } from './support/batch-iroh-offer';
import { sessionRig } from './support/batch-session';
import { within } from './support/test-deadline';

void test('separate buyers retain one global foreground turn without allocating financial work on PREPARE', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  const other = await generateKeyPairSigner();
  const terms = {
    ...rig.terms,
    buyer: other.address,
    buyerNodeId: '56'.repeat(32),
  };
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const second = await batchOfferFixture(terms, rig.owner, rig.now);
  const entered = batchDeferred<void>();
  const release = batchDeferred<void>();
  let creates = 0;
  const registry: BatchSellerRegistry = {
    list: async () => [],
    permits: async (peer) => {
      if (peer === rig.terms.buyerNodeId) {
        entered.resolve();
        await release.promise;
      }
      return true;
    },
    backend: () => ({
      inspect: async () => undefined,
      create: async () => {
        creates++;
        return rig.seller();
      },
    }),
    async dispose() {},
  };
  const host = await startSellerSessionHost({
    buyerNodeIds: [rig.terms.buyerNodeId, terms.buyerNodeId],
    registry,
    description: rig.terms,
    owner: rig.terms.owner,
    nodeId: rig.terms.sellerNodeId,
    now: rig.now,
    offers: () => [offers.live],
  });
  t.after(host.close);
  const prepare = async (
    current: typeof offers,
    proposed: PaymentSessionTerms,
  ) =>
    parseBatchChannelRequest({
      version: BATCH_CHANNEL.version,
      requestId: '12'.repeat(16),
      method: BATCH_METHODS.PREPARE,
      params: { terms: proposed, quote: await current.quote(1) },
    });
  const signal = new AbortController().signal;
  const pending = host.service.exchange(
    await prepare(offers, rig.terms),
    rig.terms.buyerNodeId,
    signal,
  );
  try {
    await within(entered.promise);
    await assert.rejects(
      host.service.exchange(
        await prepare(second, terms),
        terms.buyerNodeId,
        signal,
      ),
      { code: SESSION_CODES.BUSY },
    );
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal(creates, 0);
  assert.equal(offers.generations(), 0);
  assert.deepEqual(rig.calls, []);
});

void test('removing pilot eligibility preserves the old buyer close and status but refuses new inference', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  await rig.open();
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const registry: BatchSellerRegistry = {
    list: async () => [
      {
        buyerNodeId: rig.terms.buyerNodeId,
        stored: {
          terms: rig.terms,
          snapshot: rig.seller().snapshot(),
          pending: false,
          recoverable: false,
        },
      },
    ],
    permits: async () => true,
    backend: () => ({
      inspect: async () => ({
        terms: rig.terms,
        snapshot: rig.seller().snapshot(),
        pending: false,
        recoverable: false,
      }),
      create: async () => rig.seller(),
    }),
    async dispose() {},
  };
  const host = await startSellerSessionHost({
    buyerNodeIds: [],
    registry,
    description: rig.terms,
    owner: rig.terms.owner,
    nodeId: rig.terms.sellerNodeId,
    now: rig.now,
    offers: () => [offers.live],
  });
  t.after(host.close);
  const signal = new AbortController().signal;
  const query = (
    method: typeof BATCH_METHODS.SNAPSHOT | typeof BATCH_METHODS.CLOSE,
  ) =>
    parseBatchChannelRequest({
      version: BATCH_CHANNEL.version,
      requestId: '34'.repeat(16),
      method,
      params: { channelId: rig.seller().snapshot().channelId },
    });
  await assert.doesNotReject(
    host.service.exchange(
      query(BATCH_METHODS.SNAPSHOT),
      rig.terms.buyerNodeId,
      signal,
    ),
  );
  await assert.rejects(
    host.service.exchange(
      parseBatchChannelRequest({
        version: BATCH_CHANNEL.version,
        requestId: '56'.repeat(16),
        method: BATCH_METHODS.PREPARE,
        params: { terms: rig.terms, quote: await offers.quote(1) },
      }),
      rig.terms.buyerNodeId,
      signal,
    ),
    { code: PAID_EXECUTION_CODES.PEER },
  );
  await assert.doesNotReject(
    host.service.exchange(
      query(BATCH_METHODS.CLOSE),
      rig.terms.buyerNodeId,
      signal,
    ),
  );
  assert.deepEqual(rig.calls, ['deposit', 'refund']);
  assert.equal(offers.generations(), 0);
});
