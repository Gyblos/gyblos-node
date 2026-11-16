// Protects the public collector's receipt policy: classification of verified receipts from either
// party, their identity, and how a new report combines with the stored one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PUBLIC_RECEIPT_MERGES as MERGES,
  RECEIPT_COLLECTOR_CODES,
  PUBLIC_RECEIPT_STATUSES as STATUSES,
} from '@gyblos/core/constants';
import {
  classifyPublicReceipt,
  mergePublicReceipt,
  type PublicReceipt,
} from '@gyblos/core/public-receipts';
import { ReceiptCollectorError } from '@gyblos/core/receipt-collector';
import { canonicalJson } from '@gyblos/protocol';
import {
  RECEIPT,
  RECEIPT_DISPUTE_FIELDS,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import {
  sellerReceiptDigest,
  signBuyerReceipt,
  signSellerReceipt,
} from '@gyblos/protocol/receipt';
import {
  sellerReceiptDigestV2,
  signBuyerReceiptV2,
  signSellerReceiptV2,
} from '@gyblos/protocol/receipt-v2';

import {
  buyerRecord,
  receiptSigner,
  sellerRecord,
} from './support/receipt-fixture';
import { paidBuyerRecord, paidReceiptFixture } from './support/receipt-v2';

async function freeReceipt(options: { disputed?: boolean } = {}) {
  const seller = receiptSigner();
  const buyer = receiptSigner();
  const record = sellerRecord(seller.nodeId, buyer.nodeId);
  const sellerHalf = await signSellerReceipt(record, seller.sign);
  const confirmation = buyerRecord(record, await sellerReceiptDigest(record));
  if (options.disputed) {
    confirmation.observed.outputTokens = record.usage.outputTokens + 1;
    confirmation.verdict = RECEIPT_VERDICTS.DISPUTED;
    confirmation.disputed = [RECEIPT_DISPUTE_FIELDS.OUTPUT_TOKENS];
  }
  const buyerHalf = await signBuyerReceipt(confirmation, buyer.sign);
  return { seller, buyer, record, sellerHalf, buyerHalf };
}

async function paidReceipt() {
  const { seller, buyer, record } = paidReceiptFixture();
  const sellerHalf = await signSellerReceiptV2(record, seller.sign);
  const buyerHalf = await signBuyerReceiptV2(
    paidBuyerRecord(record, await sellerReceiptDigestV2(record)),
    buyer.sign,
  );
  return { seller, buyer, record, sellerHalf, buyerHalf };
}

const hex = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

void test('a confirmed free v1 pair is bilateral, free and keyed by seller, buyer and request', async () => {
  const { record, sellerHalf, buyerHalf } = await freeReceipt();
  const receipt: PublicReceipt = { seller: sellerHalf, buyer: buyerHalf };
  const entry = await classifyPublicReceipt(receipt);
  assert.equal(entry.status, STATUSES.BILATERAL);
  assert.equal(entry.version, RECEIPT.version);
  assert.equal(entry.paid, false);
  assert.equal(
    entry.key,
    canonicalJson([record.sellerNodeId, record.buyerNodeId, record.requestId]),
  );
  assert.equal(entry.sellerDigest, await sellerReceiptDigest(record));
  assert.equal(entry.fingerprint, hex(receipt));
  assert.deepEqual(entry.receipt, receipt);
});

void test('a paid v2 pair is accepted and marked paid', async () => {
  const { record, sellerHalf, buyerHalf } = await paidReceipt();
  const entry = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: buyerHalf,
  });
  assert.equal(entry.status, STATUSES.BILATERAL);
  assert.equal(entry.version, 2);
  assert.equal(entry.paid, true);
  assert.equal(entry.sellerDigest, await sellerReceiptDigestV2(record));
});

void test('a seller-only receipt is accepted as seller-only for both versions', async () => {
  const free = await freeReceipt();
  const paid = await paidReceipt();
  const receipts: PublicReceipt[] = [
    { seller: free.sellerHalf },
    { seller: paid.sellerHalf },
  ];
  for (const receipt of receipts) {
    const entry = await classifyPublicReceipt(receipt);
    assert.equal(entry.status, STATUSES.SELLER_ONLY);
  }
});

void test('a buyer dispute is kept as disputed, never merged into agreed usage', async () => {
  const { sellerHalf, buyerHalf } = await freeReceipt({ disputed: true });
  const entry = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: buyerHalf,
  });
  assert.equal(entry.status, STATUSES.DISPUTED);
});

void test('a buyer whose dispute list does not match its own observations is refused', async () => {
  const { buyer, record, sellerHalf } = await freeReceipt();
  const confirmation = buyerRecord(record, await sellerReceiptDigest(record));
  // The buyer observed a different count but claims agreement with nothing disputed.
  confirmation.observed.outputTokens = record.usage.outputTokens + 3;
  const buyerHalf = await signBuyerReceipt(confirmation, buyer.sign);
  await assert.rejects(
    classifyPublicReceipt({ seller: sellerHalf, buyer: buyerHalf }),
    (error: unknown) =>
      error instanceof ReceiptCollectorError &&
      error.code === RECEIPT_COLLECTOR_CODES.DISPUTE,
  );
});

void test('a first report is inserted and the same report again is identical', async () => {
  const { sellerHalf, buyerHalf } = await freeReceipt();
  const entry = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: buyerHalf,
  });
  assert.deepEqual(mergePublicReceipt(null, entry), {
    merge: MERGES.INSERT,
    entry,
  });
  assert.deepEqual(mergePublicReceipt(entry, structuredClone(entry)), {
    merge: MERGES.IDENTICAL,
    entry,
  });
});

void test('a buyer half completes a stored seller-only receipt, never the reverse', async () => {
  const { sellerHalf, buyerHalf } = await freeReceipt();
  const sellerOnly = await classifyPublicReceipt({ seller: sellerHalf });
  const paired = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: buyerHalf,
  });
  assert.deepEqual(mergePublicReceipt(sellerOnly, paired), {
    merge: MERGES.UPGRADE,
    entry: paired,
  });
  // A later seller-only copy of an already paired receipt changes nothing.
  assert.deepEqual(mergePublicReceipt(paired, sellerOnly), {
    merge: MERGES.IDENTICAL,
    entry: paired,
  });
});

void test('a different seller record or a second buyer attestation for one key conflicts', async () => {
  const { seller, buyer, record, sellerHalf, buyerHalf } = await freeReceipt();
  const stored = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: buyerHalf,
  });

  const changed = { ...record, usage: { ...record.usage, outputTokens: 99 } };
  const otherSeller = await classifyPublicReceipt({
    seller: await signSellerReceipt(changed, seller.sign),
  });
  assert.equal(mergePublicReceipt(stored, otherSeller).merge, MERGES.CONFLICT);

  const digestChanged = { ...record, requestDigest: '55'.repeat(32) };
  const otherRequest = await classifyPublicReceipt({
    seller: await signSellerReceipt(digestChanged, seller.sign),
  });
  assert.equal(otherRequest.key, stored.key);
  assert.equal(mergePublicReceipt(stored, otherRequest).merge, MERGES.CONFLICT);

  const amended = buyerRecord(record, await sellerReceiptDigest(record));
  amended.observed.totalMs += 1;
  const secondBuyer = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: await signBuyerReceipt(amended, buyer.sign),
  });
  const result = mergePublicReceipt(stored, secondBuyer);
  assert.equal(result.merge, MERGES.CONFLICT);
  // The first accepted buyer attestation stays the stored one.
  assert.equal(result.entry, stored);
});

void test('entries for different keys never merge', async () => {
  const first = await freeReceipt();
  const second = await freeReceipt();
  const a = await classifyPublicReceipt({ seller: first.sellerHalf });
  const b = await classifyPublicReceipt({ seller: second.sellerHalf });
  assert.throws(
    () => mergePublicReceipt(a, b),
    (error: unknown) =>
      error instanceof ReceiptCollectorError &&
      error.code === RECEIPT_COLLECTOR_CODES.INVALID,
  );
});
