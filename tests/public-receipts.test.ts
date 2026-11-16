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
  ReceiptCollectorError,
  type PublicReceipt,
} from '@gyblos/core/public-receipts';
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_CODES,
  RECEIPT,
  RECEIPT_DISPUTE_FIELDS,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
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
const collectorCode = (code: string) => (error: unknown) =>
  error instanceof ReceiptCollectorError && error.code === code;
const controlCode = (code: string) => (error: unknown) =>
  error instanceof ControlError && error.code === code;

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
  assert.equal(entry.fingerprint, hex([record, buyerHalf.record]));
  assert.equal(entry.buyerDigest, hex(buyerHalf.record));
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
    collectorCode(RECEIPT_COLLECTOR_CODES.DISPUTE),
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
  assert.equal(
    mergePublicReceipt(stored, otherSeller).merge,
    MERGES.SELLER_CONFLICT,
  );

  const digestChanged = { ...record, requestDigest: '55'.repeat(32) };
  const otherRequest = await classifyPublicReceipt({
    seller: await signSellerReceipt(digestChanged, seller.sign),
  });
  assert.equal(otherRequest.key, stored.key);
  assert.equal(
    mergePublicReceipt(stored, otherRequest).merge,
    MERGES.SELLER_CONFLICT,
  );

  const amended = buyerRecord(record, await sellerReceiptDigest(record));
  amended.observed.totalMs += 1;
  const secondBuyer = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: await signBuyerReceipt(amended, buyer.sign),
  });
  const result = mergePublicReceipt(stored, secondBuyer);
  assert.equal(result.merge, MERGES.BUYER_CONFLICT);
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
    collectorCode(RECEIPT_COLLECTOR_CODES.INVALID),
  );
});

void test('classification verifies node signatures and cross-binding itself', async () => {
  const { sellerHalf } = await freeReceipt();
  const tampered = structuredClone(sellerHalf);
  tampered.record.usage.outputTokens += 1;
  await assert.rejects(
    classifyPublicReceipt({ seller: tampered }),
    controlCode(CONTROL_CODES.SIGNATURE),
  );
  const other = await freeReceipt();
  await assert.rejects(
    classifyPublicReceipt({ seller: sellerHalf, buyer: other.buyerHalf }),
    (error: unknown) => error instanceof ControlError,
  );
  await assert.rejects(
    classifyPublicReceipt({ seller: { record: 'x', signature: '' } }),
    collectorCode(RECEIPT_COLLECTOR_CODES.INVALID),
  );
});

void test('the entry keeps a detached copy, unaffected by later caller mutation', async () => {
  const { sellerHalf, buyerHalf } = await freeReceipt();
  const input = structuredClone({ seller: sellerHalf, buyer: buyerHalf });
  const pending = classifyPublicReceipt(input);
  input.seller.record.usage.outputTokens = 999;
  const entry = await pending;
  input.buyer.record.observed.totalMs = 1;
  assert.deepEqual(entry.receipt, { seller: sellerHalf, buyer: buyerHalf });
});

void test('dispute lists must match the observations exactly, outputBytes included', async () => {
  const { buyer, record, sellerHalf } = await freeReceipt();
  const digest = await sellerReceiptDigest(record);
  const matching = buyerRecord(record, digest);
  matching.verdict = RECEIPT_VERDICTS.DISPUTED;
  matching.disputed = [RECEIPT_DISPUTE_FIELDS.OUTPUT_TOKENS];
  const unobserved = buyerRecord(record, digest);
  unobserved.observed.outputTokens = null;
  unobserved.verdict = RECEIPT_VERDICTS.DISPUTED;
  unobserved.disputed = [RECEIPT_DISPUTE_FIELDS.OUTPUT_TOKENS];
  for (const confirmation of [matching, unobserved])
    await assert.rejects(
      classifyPublicReceipt({
        seller: sellerHalf,
        buyer: await signBuyerReceipt(confirmation, buyer.sign),
      }),
      collectorCode(RECEIPT_COLLECTOR_CODES.DISPUTE),
    );
  const bytes = buyerRecord(record, digest);
  bytes.observed.outputBytes = record.sizes.outputBytes + 4;
  bytes.verdict = RECEIPT_VERDICTS.DISPUTED;
  bytes.disputed = [RECEIPT_DISPUTE_FIELDS.OUTPUT_BYTES];
  const entry = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: await signBuyerReceipt(bytes, buyer.sign),
  });
  assert.equal(entry.status, STATUSES.DISPUTED);
});

void test('a seller cannot erase a stored buyer dispute by signing a second record', async () => {
  const { seller, record, sellerHalf, buyerHalf } = await freeReceipt({
    disputed: true,
  });
  const sellerOnly = await classifyPublicReceipt({ seller: sellerHalf });
  const disputed = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: buyerHalf,
  });
  const upgraded = mergePublicReceipt(sellerOnly, disputed);
  assert.equal(upgraded.merge, MERGES.UPGRADE);
  const rewritten = await classifyPublicReceipt({
    seller: await signSellerReceipt(
      { ...record, usage: { ...record.usage, outputTokens: 6 } },
      seller.sign,
    ),
  });
  const result = mergePublicReceipt(upgraded.entry, rewritten);
  assert.equal(result.merge, MERGES.SELLER_CONFLICT);
  assert.equal(result.entry.status, STATUSES.DISPUTED);

  // A different seller-only record against a stored seller-only one is also the seller's conflict.
  assert.equal(
    mergePublicReceipt(sellerOnly, rewritten).merge,
    MERGES.SELLER_CONFLICT,
  );
});

void test('a buyer cannot turn its stored dispute into agreement with a second attestation', async () => {
  const { buyer, record, sellerHalf, buyerHalf } = await freeReceipt({
    disputed: true,
  });
  const stored = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: buyerHalf,
  });
  const agreed = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: await signBuyerReceipt(
      buyerRecord(record, await sellerReceiptDigest(record)),
      buyer.sign,
    ),
  });
  const result = mergePublicReceipt(stored, agreed);
  assert.equal(result.merge, MERGES.BUYER_CONFLICT);
  assert.equal(result.entry.status, STATUSES.DISPUTED);
});

void test('a paid v2 buyer dispute is kept as disputed evidence', async () => {
  const { seller, buyer, record } = paidReceiptFixture();
  const sellerHalf = await signSellerReceiptV2(record, seller.sign);
  const confirmation = paidBuyerRecord(
    record,
    await sellerReceiptDigestV2(record),
  );
  confirmation.observed.outputTokens = record.usage.outputTokens + 1;
  confirmation.verdict = RECEIPT_VERDICTS.DISPUTED;
  confirmation.disputed = [RECEIPT_DISPUTE_FIELDS.OUTPUT_TOKENS];
  const entry = await classifyPublicReceipt({
    seller: sellerHalf,
    buyer: await signBuyerReceiptV2(confirmation, buyer.sign),
  });
  assert.equal(entry.status, STATUSES.DISPUTED);
  assert.equal(entry.paid, true);
});
