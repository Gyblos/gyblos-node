// Before-signing session agreement over loopback; synthetic signers only, no real funds or RPC.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  BatchChannelError,
  batchChannelResponse,
  matchBatchChannelResponse,
  parseBatchChannelRequest,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES, type PaymentSessionTerms } from '@gyblos/protocol/payment-session';

import { batchDeferred } from './support/batch-deferred';
import { batchPrepareFixture } from './support/batch-prepare';

void test('prepare returns exact detached terms without touching financial or engine methods', async (t) => {
  const f = await batchPrepareFixture(); t.after(f.close);
  const calls = ['open', 'reserve', 'finish', 'accept', 'close', 'tick', 'snapshot'] as const;
  const observed = calls.map((method) => t.mock.method(f.session, method));
  const request = parseBatchChannelRequest({
    version: BATCH_CHANNEL.version, requestId: '12'.repeat(16),
    method: BATCH_METHODS.PREPARE, params: { quote: await f.offers.quote(1) },
  });
  const result = await f.service.exchange(request, f.rig.terms.buyerNodeId, new AbortController().signal);
  assert.ok('terms' in result);
  assert.deepEqual(result.terms, f.rig.terms);
  result.terms.depositAtomic = '2000';
  const repeated = await f.service.exchange(request, f.rig.terms.buyerNodeId, new AbortController().signal);
  assert.ok('terms' in repeated);
  assert.equal(repeated.terms.depositAtomic, '1000');
  assert.deepEqual(observed.map((mock) => mock.mock.callCount()), calls.map(() => 0));
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, []);
});

const altered: ReadonlyArray<readonly [keyof PaymentSessionTerms, string | number]> = [
  ['buyer', '11111111111111111111111111111111'],
  ['buyerNodeId', '56'.repeat(32)],
  ['owner', '11111111111111111111111111111111'],
  ['sellerNodeId', '56'.repeat(32)],
  ['network', 'solana:synthetic'],
  ['mint', '11111111111111111111111111111111'],
  ['payTo', '11111111111111111111111111111111'],
  ['feePayer', '11111111111111111111111111111111'],
  ['authorizer', '11111111111111111111111111111111'],
  ['treasury', '11111111111111111111111111111111'],
  ['protocolFeeBps', 400], ['depositAtomic', '2000'],
  ['expiresAt', 1_800_004_000_000], ['withdrawDelaySeconds', 1800],
];
for (const [field, value] of altered) {
  void test(`prepare: altered ${field} cannot cause an opening signature`, async (t) => {
    const f = await batchPrepareFixture(); t.after(f.close);
    const opening = t.mock.method(f.rig.buyer, 'open');
    f.replied(async (result) => 'terms' in result ? { terms: { ...result.terms, [field]: value } } : result);
    await assert.rejects(f.buyer.execute(await f.offers.quote(1), f.offers.input), { code: SESSION_CODES.BINDING });
    assert.equal(opening.mock.callCount(), 0);
    assert.equal(f.offers.generations(), 0);
    assert.deepEqual(f.rig.calls, []);
  });
}
void test('prepare: an older peer refuses before opening or sending a prompt', async (t) => {
  const f = await batchPrepareFixture(); t.after(f.close);
  const opening = t.mock.method(f.rig.buyer, 'open');
  f.intercept(async (...args) => {
    if (args[0].method === BATCH_METHODS.PREPARE) throw new BatchChannelError(SESSION_CODES.INVALID);
    return f.service.exchange(...args);
  });
  await assert.rejects(f.buyer.execute(await f.offers.quote(1), f.offers.input), { code: SESSION_CODES.INVALID });
  assert.equal(opening.mock.callCount(), 0);
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, []);
});
void test('prepare: quote expiry during the reply forbids a late opening signature', async (t) => {
  const f = await batchPrepareFixture(); t.after(f.close);
  const opening = t.mock.method(f.rig.buyer, 'open');
  const quote = await f.offers.quote(1);
  f.replied(async (result) => { if ('terms' in result) f.rig.time(quote.offer.expiresAt); return result; });
  await assert.rejects(f.buyer.execute(quote, f.offers.input), { code: PAID_EXECUTION_CODES.EXPIRED });
  assert.equal(opening.mock.callCount(), 0);
  assert.deepEqual(f.rig.calls, []);
});
void test('prepare: disconnect suppresses a late reply and opening signature', async (t) => {
  const f = await batchPrepareFixture(); t.after(f.close);
  const entered = batchDeferred<void>(); const release = batchDeferred<void>();
  const opening = t.mock.method(f.rig.buyer, 'open');
  f.replied(async (result) => { if ('terms' in result) { entered.resolve(); await release.promise; } return result; });
  const run = f.buyer.execute(await f.offers.quote(1), f.offers.input);
  const rejected = assert.rejects(run, { code: PAID_EXECUTION_CODES.CANCELLED });
  await entered.promise;
  await f.buyer.disconnect(); release.resolve(); await rejected;
  await f.buyer.settled();
  assert.equal(opening.mock.callCount(), 0);
  assert.deepEqual(f.rig.calls, []);
});
void test('prepare: independent policy is rechecked after the reply before signing', async (t) => {
  const f = await batchPrepareFixture(); t.after(f.close);
  const opening = t.mock.method(f.rig.buyer, 'open');
  f.replied(async (result) => { if ('terms' in result) f.verification(async () => { throw new BatchChannelError(SESSION_CODES.UNVERIFIED); }); return result; });
  await assert.rejects(f.buyer.execute(await f.offers.quote(1), f.offers.input), { code: SESSION_CODES.UNVERIFIED });
  assert.equal(f.verified(), 2);
  assert.equal(opening.mock.callCount(), 0);
  assert.deepEqual(f.rig.calls, []);
});
void test('prepare replies require strict full terms and exact request correlation', async (t) => {
  const f = await batchPrepareFixture(); t.after(f.close);
  const request: BatchChannelRequest = { version: BATCH_CHANNEL.version, requestId: '12'.repeat(16), method: BATCH_METHODS.PREPARE, params: { quote: await f.offers.quote(1) } };
  const reply = await batchChannelResponse(request, { terms: f.rig.terms });
  assert.deepEqual((await matchBatchChannelResponse(reply, request)).result, { terms: f.rig.terms });
  await assert.rejects(matchBatchChannelResponse({ ...reply, requestDigest: '56'.repeat(32) }, request), { code: SESSION_CODES.BINDING });
  await assert.rejects(batchChannelResponse(request, { terms: { ...f.rig.terms, unknown: true } }), { code: SESSION_CODES.INVALID });
  await assert.rejects(batchChannelResponse(request, { terms: { ...f.rig.terms, depositAtomic: '01000' } }), { code: SESSION_CODES.INVALID });
});
