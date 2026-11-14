// The duplex path keeps the existing frame, absolute deadline and uncertain-first-write protections.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { PAYMENT_SESSION } from '@gyblos/protocol/payment-session';
import { chargeV2 } from '@gyblos/core/pricing-v2';
import {
  SESSION_BLOCKS,
  SESSION_BLOCK_KINDS,
  encodeSessionBlock,
  sessionBlockDigest,
  sessionBlockRequestDigest,
} from '@gyblos/protocol/session-blocks';
import {
  createBatchChannelClient,
  type BatchBlockClient,
} from '@gyblos/transport-iroh/batch-client';
import { IROH_DEADLINES } from '@gyblos/transport-iroh/constants';

import { batchDeferred } from './support/batch-deferred';
import {
  batchMemoryPeer,
  batchStreamFixture,
} from './support/batch-stream-fixture';

async function framing(
  bytes: Uint8Array,
  writeFailure = false,
  beforeRead?: (index: number) => Promise<void>,
) {
  const f = await batchStreamFixture();
  const peer = batchMemoryPeer(bytes, writeFailure, beforeRead);
  const requestDigest = await sessionBlockRequestDigest(f.request.params);
  const client = createBatchChannelClient(
    peer.endpoint,
    peer.destination,
    peer.destination.id().toString(),
    { blocks: true, now: () => f.request.params.quote.offer.issuedAt },
  );
  let approvals = 0;
  const callbacks: BatchBlockClient = {
    verification: {
      binding: {
        channelId: f.request.params.channelId,
        requestId: f.request.params.requestId,
        requestDigest,
      },
      request: {
        requestId: f.request.params.requestId,
        requestDigest,
        maxAtomic: f.request.params.quote.offer.maxAtomic,
      },
      baseAtomic: '0',
      depositAtomic: '1000000',
      maxTokens: f.request.params.input.maxTokens,
      verify: async () => {
        throw new Error('Invalid frame reached verification');
      },
    },
    approve: async () => {
      approvals++;
      throw new Error('Forbidden synthetic approval');
    },
    acknowledge: async () => {},
  };
  return {
    peer,
    request: f.request,
    callbacks,
    approvals: () => approvals,
    run: () => client.exchange(f.request, undefined, undefined, callbacks),
    async close() {
      await client.close();
      await client.settled();
    },
  };
}
void test('block response length is rejected from its prefix before a body read or signature', async (t) => {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(SESSION_BLOCKS.frameBytes + 1);
  const f = await framing(prefix);
  t.after(f.close);
  await assert.rejects(f.run(), { code: SESSION_CODES.LIMIT, sent: true });
  assert.equal(f.peer.reads(), 2);
  assert.equal(f.approvals(), 0);
});
void test('the next declared block is checked against the remaining transcript before reading its body', async (t) => {
  const source = await batchStreamFixture();const request = source.request.params;
  const requestDigest = await sessionBlockRequestDigest(request);
  const amount = String(chargeV2({ input: 12, output: 1 }, request.quote.offer.prices));
  const header = { version: SESSION_BLOCKS.version, channelId: request.channelId, requestId: request.requestId, requestDigest, index: 0 };
  const checkpoint = { ...header, kind: SESSION_BLOCK_KINDS.CHECKPOINT, text: '\u0001'.repeat(160000), usage: { inputTokens: 12, outputTokens: 1 }, bill: { requestId: request.requestId, requestDigest, maxAtomic: request.quote.offer.maxAtomic, chargedAtomic: amount, cumulativeAtomic: amount }, terminal: null };
  const digest = await sessionBlockDigest(checkpoint);
  const ack = { ...header, kind: SESSION_BLOCK_KINDS.ACK, blockDigest: digest, cumulativeAtomic: amount };
  const prefix = Buffer.alloc(4);prefix.writeUInt32BE(SESSION_BLOCKS.frameBytes - 1000);
  const f = await framing(Buffer.concat([encodeSessionBlock(checkpoint), encodeSessionBlock(ack), prefix]));t.after(f.close);
  f.callbacks.verification.verify = async () => ({ ...checkpoint.usage, chargedAtomic: amount });
  f.callbacks.approve = async () => ({ channelId: request.channelId, maxClaimableAmount: amount, expiresAt: PAYMENT_SESSION.voucherExpiry, signature: '1'.repeat(64) });
  await assert.rejects(f.run(), { code: SESSION_CODES.LIMIT, sent: true });assert.equal(f.peer.reads(), 8);
});
void test('a failed first prompt write stays possibly sent and never reads, approves or retries', async (t) => {
  const f = await framing(new Uint8Array(), true);
  t.after(f.close);
  await assert.rejects(f.run(), { sent: true });
  assert.equal(f.peer.writes(), 1);
  assert.equal(f.peer.reads(), 0);
  assert.equal(f.approvals(), 0);
});
void test('once a block prefix begins its slow remainder expires under the existing ingress budget', async (t) => {
  const entered = batchDeferred<void>();
  const release = batchDeferred<void>();
  const original = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (
      callback: Parameters<typeof original>[0],
      milliseconds?: number,
      ...args: unknown[]
    ) =>
      original(
        callback,
        milliseconds === IROH_DEADLINES.ingressMs ? 1 : milliseconds,
        ...args,
      ),
  );
  const f = await framing(Buffer.alloc(4), false, async (index) => {
    if (index === 2) {
      entered.resolve();
      await release.promise;
    }
  });
  t.after(f.close);
  const result = f.run();
  const rejected = assert.rejects(result, {
    code: PAID_EXECUTION_CODES.TIMEOUT,
    sent: true,
  });
  try {
    await entered.promise;
    await rejected;
    assert.equal(f.approvals(), 0);
  } finally {
    release.resolve();
  }
});
