// Exercises the metrics collector app with memory storage and ephemeral signers: admission order,
// verification, the clock window, replay, per-side reports and fail-closed configuration.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PUBLIC_RECEIPT_MERGES as MERGES } from '@gyblos/core/constants';
import { COLLECTOR_ERRORS } from '@gyblos/metrics-collector/constants';
import { createMemoryStorage } from '@gyblos/metrics-collector/storage-memory';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import {
  COLLECTOR_CLIENT_IP,
  responseJson,
  signUpload,
  testCollector,
} from './support/metrics-collector';
import {
  buyerUpload,
  freePair,
  sellerUpload,
  T0,
} from './support/receipt-upload';

void test('an upload is accepted with a count only, stored once and reported per side', async () => {
  const memory = createMemoryStorage();
  const { post } = testCollector(memory.storage);
  const { seller, buyer, receipt } = await freePair();

  assert.deepEqual(
    await responseJson(
      await post(
        await signUpload(sellerUpload(seller.nodeId, receipt), seller.sign),
      ),
    ),
    { status: 200, body: { receivedAt: T0, accepted: 1 } },
  );
  const buyerReport = buyerUpload(buyer.nodeId, receipt);
  assert.equal(
    (await post(await signUpload(buyerReport, buyer.sign))).status,
    200,
  );
  assert.equal(memory.entries.size, 1);
  assert.deepEqual(
    memory.reports.map((report) => report.merge),
    [MERGES.INSERT, MERGES.IDENTICAL],
  );
  assert.deepEqual(Object.keys([...memory.firstReports.values()][0]!).sort(), [
    P2P_ROLES.BUYER,
    P2P_ROLES.SELLER,
  ]);
  // The buyer's own claims are kept with its report.
  assert.equal(memory.reports[1]!.startedAt, buyerReport.items[0]!.startedAt);
});

void test('a buyer may report first; the seller report and a later seller-only copy change nothing', async () => {
  const memory = createMemoryStorage();
  const { post } = testCollector(memory.storage);
  const { seller, buyer, receipt } = await freePair();
  await post(await signUpload(buyerUpload(buyer.nodeId, receipt), buyer.sign));
  await post(
    await signUpload(sellerUpload(seller.nodeId, receipt), seller.sign),
  );
  const sellerOnly = sellerUpload(seller.nodeId, { seller: receipt.seller });
  sellerOnly.nonce = 'cd'.repeat(16);
  await post(await signUpload(sellerOnly, seller.sign));
  assert.deepEqual(
    memory.reports.map((report) => report.merge),
    [MERGES.INSERT, MERGES.IDENTICAL, MERGES.IDENTICAL],
  );
  assert.equal([...memory.entries.values()][0]!.status, 'bilateral');
  assert.equal(memory.history.length, 1);
});

void test('uploads outside the clock window get the collector time to correct and resend', async () => {
  const { seller, receipt } = await freePair();
  const later = T0 + 3_600_000;
  const { post, node } = testCollector(createMemoryStorage().storage, {
    now: () => later,
  });
  assert.deepEqual(
    await responseJson(
      await post(
        await signUpload(sellerUpload(seller.nodeId, receipt), seller.sign),
      ),
    ),
    {
      status: 409,
      body: { error: COLLECTOR_ERRORS.STALE_UPLOAD, serverTime: later },
    },
  );
  // A stale upload never spends the node's allowance.
  assert.deepEqual(node.keys, []);
});

void test('a reused nonce is a replay even with a different sentAt, and stores nothing', async () => {
  const memory = createMemoryStorage();
  const { post } = testCollector(memory.storage);
  const { seller, receipt } = await freePair();
  const upload = sellerUpload(seller.nodeId, receipt);
  assert.equal((await post(await signUpload(upload, seller.sign))).status, 200);
  const again = { ...upload, sentAt: upload.sentAt + 1 };
  assert.deepEqual(
    await responseJson(await post(await signUpload(again, seller.sign))),
    {
      status: 409,
      body: { error: COLLECTOR_ERRORS.REPLAYED_UPLOAD },
    },
  );
  assert.equal(memory.reports.length, 1);
});

void test('bad signatures, malformed bodies, wrong content types and oversized bodies get static codes', async () => {
  const { post } = testCollector(createMemoryStorage().storage);
  const { seller, receipt } = await freePair();
  const body = await signUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );

  const tampered = structuredClone(body);
  tampered.upload.items[0]!.storedAt = 1;
  assert.deepEqual((await responseJson(await post(tampered))).body, {
    error: COLLECTOR_ERRORS.INVALID_SIGNATURE,
  });
  const brokenReceipt = structuredClone(body);
  brokenReceipt.upload.items[0]!.receipt.seller.record.usage.outputTokens += 1;
  const resigned = await signUpload(brokenReceipt.upload, seller.sign);
  assert.deepEqual((await responseJson(await post(resigned))).body, {
    error: COLLECTOR_ERRORS.INVALID_SIGNATURE,
  });
  assert.deepEqual((await responseJson(await post('{"upload":'))).body, {
    error: COLLECTOR_ERRORS.INVALID_UPLOAD,
  });
  assert.deepEqual(
    (
      await responseJson(
        await post(body, undefined, { 'content-type': 'text/plain' }),
      )
    ).body,
    { error: COLLECTOR_ERRORS.INVALID_UPLOAD },
  );
  assert.equal((await post('x'.repeat(400_000))).status, 413);
});

void test('the node allowance is spent only after the envelope signature verifies', async () => {
  const { post, node } = testCollector(createMemoryStorage().storage, {
    node: false,
  });
  const { seller, receipt } = await freePair();
  const body = await signUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  const junk = { ...body, signature: '00'.repeat(64) };
  assert.equal((await post(junk)).status, 400);
  assert.deepEqual(node.keys, []);
  assert.deepEqual(await responseJson(await post(body)), {
    status: 429,
    body: { error: COLLECTOR_ERRORS.RATE_LIMITED },
  });
  assert.deepEqual(node.keys, [seller.nodeId]);
});

void test('missing configuration fails closed; address and global limits apply; plain http is refused', async () => {
  assert.equal((await testCollector(undefined).post({})).status, 503);
  const memory = createMemoryStorage();
  const limited = testCollector(memory.storage, { ip: false });
  assert.equal((await limited.post({})).status, 429);
  assert.deepEqual(limited.ip.keys, [COLLECTOR_CLIENT_IP]);
  const v6 = testCollector(memory.storage);
  await v6.post({}, undefined, { 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' });
  assert.deepEqual(v6.ip.keys, ['2001:db8:1:2::/64']);
  // Junk never spends the shared write budget; only a verified upload does.
  const budget = testCollector(memory.storage, { global: false });
  assert.equal((await budget.post({})).status, 400);
  assert.deepEqual(budget.global.keys, []);
  const { seller, receipt } = await freePair();
  const verified = await signUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  assert.equal((await budget.post(verified)).status, 429);
  assert.equal(budget.global.keys.length, 1);
  assert.deepEqual(
    (
      await responseJson(
        await testCollector(memory.storage).post({}, 'http://collector.test'),
      )
    ).body,
    { error: COLLECTOR_ERRORS.HTTPS_REQUIRED },
  );
});
