// Paid receipt/v2 claims are strict, bounded and signed; v1 remains an independent contract.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  FREE_EXECUTION_CODES,
  OFFER_PRICING_KINDS,
  RECEIPT_OUTCOMES,
} from '@gyblos/protocol/constants';
import {
  signBuyerReceipt,
  signSellerReceipt,
  verifyReceipt,
} from '@gyblos/protocol/receipt';
import {
  parseBuyerReceiptV2,
  parseSellerReceiptV2,
  sellerReceiptDigestV2,
  signBuyerReceiptV2,
  signSellerReceiptV2,
  verifyReceiptV2,
} from '@gyblos/protocol/receipt-v2';

import { buyerRecord, sellerRecord } from './support/receipt-fixture';
import {
  paidBuyerRecord,
  paidReceiptFixture,
  paidRecord,
  receiptAddress,
} from './support/receipt-v2';

async function paired() {
  const f = paidReceiptFixture();
  const seller = await signSellerReceiptV2(f.record, f.seller.sign);
  const buyer = await signBuyerReceiptV2(
    paidBuyerRecord(f.record, await sellerReceiptDigestV2(f.record)),
    f.buyer.sign,
  );
  return { ...f, receipt: { seller, buyer } };
}
void test('paid receipt/v2 parses detached channel and shared observation fields', () => {
  const record = paidRecord();
  const parsed = parseSellerReceiptV2(record);
  assert.deepEqual(parsed, record);
  assert.notEqual(parsed.channel, record.channel);
  assert.notEqual(parsed.pricing.prices, record.pricing.prices);
  const buyer = paidBuyerRecord(record, '66'.repeat(32));
  assert.deepEqual(parseBuyerReceiptV2(buyer), buyer);
});
void test('paid receipt/v2 verifies a seller-only record and a buyer countersignature without a clock', async () => {
  const f = await paired();
  assert.deepEqual(await verifyReceiptV2(f.receipt), f.receipt);
  assert.deepEqual(await verifyReceiptV2({ seller: f.receipt.seller }), {
    seller: f.receipt.seller,
  });
  await assert.rejects(signSellerReceiptV2(f.record, f.buyer.sign), {
    code: CONTROL_CODES.SIGNATURE,
  });
  await assert.rejects(
    signBuyerReceiptV2(f.receipt.buyer.record, f.seller.sign),
    { code: CONTROL_CODES.SIGNATURE },
  );
});
void test('paid receipt/v2 attributes fee rounding across cumulative intervals', () => {
  const first = parseSellerReceiptV2(paidRecord());
  const next = parseSellerReceiptV2({
    ...first,
    feeAtomic: '3',
    channel: { ...first.channel, baseAtomic: '70', cumulativeAtomic: '140' },
  });
  assert.equal(first.amountAtomic, '70');
  assert.equal(next.amountAtomic, '70');
  assert.equal(BigInt(first.feeAtomic) + BigInt(next.feeAtomic), 5n);
  assert.throws(() => parseSellerReceiptV2({ ...next, feeAtomic: '2' }), {
    code: CONTROL_CODES.POLICY,
  });
});
void test('paid receipt/v2 represents an uncharged priced attempt without claiming settlement', () => {
  const record = paidRecord();
  const cancelled = {
    ...record,
    amountAtomic: '0',
    feeAtomic: '0',
    channel: { ...record.channel, baseAtomic: '70', cumulativeAtomic: '70' },
    outcome: RECEIPT_OUTCOMES.CANCELLED,
    code: FREE_EXECUTION_CODES.CANCELLED,
    finishReason: null,
  };
  assert.deepEqual(parseSellerReceiptV2(cancelled), cancelled);
});
void test('paid receipt/v2 rejects inconsistent authorization intervals and fee differences', () => {
  const record = paidRecord();
  for (const value of [
    { ...record, amountAtomic: '69' },
    { ...record, feeAtomic: '1' },
    { ...record, channel: { ...record.channel, baseAtomic: '71' } },
    {
      ...record,
      pricing: { kind: OFFER_PRICING_KINDS.FREE },
      amountAtomic: '0',
      feeAtomic: '0',
    },
    {
      ...record,
      pricing: {
        ...record.pricing,
        prices: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
      },
    },
  ])
    assert.throws(() => parseSellerReceiptV2(value), {
      code: CONTROL_CODES.POLICY,
    });
});
void test('paid receipt/v2 rejects unknown channel fields, malformed addresses and noncanonical amounts', () => {
  const record = paidRecord();
  for (const channel of [
    { ...record.channel, internalEndpoint: 'synthetic' },
    { ...record.channel, channelId: '' },
    { ...record.channel, payer: 'synthetic-invalid' },
    { ...record.channel, baseAtomic: '00' },
    { ...record.channel, cumulativeAtomic: '070' },
    { ...record.channel, cumulativeAtomic: '18446744073709551616' },
    { ...record.channel, protocolFeeBps: 0.5 },
    { ...record.channel, protocolFeeBps: -1 },
    { ...record.channel, protocolFeeBps: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => parseSellerReceiptV2({ ...record, channel }), {
      code: CONTROL_CODES.INVALID,
    });
});
void test('every channel field and the pricing network are covered by the seller signature', async () => {
  const f = await paired();
  for (const channel of [
    { ...f.record.channel, channelId: receiptAddress(6) },
    { ...f.record.channel, payer: receiptAddress(6) },
    { ...f.record.channel, baseAtomic: '1', cumulativeAtomic: '71' },
    { ...f.record.channel, protocolFeeBps: 401 },
  ])
    await assert.rejects(
      verifyReceiptV2({
        seller: { ...f.receipt.seller, record: { ...f.record, channel } },
      }),
      { code: CONTROL_CODES.SIGNATURE },
    );
  await assert.rejects(
    verifyReceiptV2({
      seller: {
        ...f.receipt.seller,
        record: {
          ...f.record,
          pricing: { ...f.record.pricing, network: 'solana:another' },
        },
      },
    }),
    { code: CONTROL_CODES.SIGNATURE },
  );
});
void test('buyer countersignatures cannot be moved to another valid channel claim or request', async () => {
  const f = await paired();
  const seller = await signSellerReceiptV2(
    {
      ...f.record,
      channel: { ...f.record.channel, channelId: receiptAddress(6) },
    },
    f.seller.sign,
  );
  await assert.rejects(verifyReceiptV2({ seller, buyer: f.receipt.buyer }), {
    code: CONTROL_CODES.POLICY,
  });
  const buyer = await signBuyerReceiptV2(
    { ...f.receipt.buyer.record, requestId: '77'.repeat(16) },
    f.buyer.sign,
  );
  await assert.rejects(verifyReceiptV2({ seller: f.receipt.seller, buyer }), {
    code: CONTROL_CODES.POLICY,
  });
});
void test('receipt/v1 and paid receipt/v2 records, signatures and halves stay version-separated', async () => {
  const f = await paired();
  const oldRecord = sellerRecord(f.seller.nodeId, f.buyer.nodeId);
  const seller = await signSellerReceipt(oldRecord, f.seller.sign);
  const buyer = await signBuyerReceipt(
    buyerRecord(oldRecord, '66'.repeat(32)),
    f.buyer.sign,
  );
  await assert.rejects(verifyReceiptV2({ seller }), {
    code: CONTROL_CODES.VERSION,
  });
  await assert.rejects(verifyReceiptV2({ seller: f.receipt.seller, buyer }), {
    code: CONTROL_CODES.VERSION,
  });
  await assert.rejects(verifyReceipt(f.receipt), {
    code: CONTROL_CODES.INVALID,
  });
  await assert.rejects(
    verifyReceiptV2({
      seller: { ...f.receipt.seller, signature: seller.signature },
    }),
    { code: CONTROL_CODES.SIGNATURE },
  );
});
void test('paid receipt/v2 detaches both records before asynchronous signature verification', async () => {
  const f = await paired();
  const mutable = structuredClone(f.receipt);
  const checking = verifyReceiptV2(mutable);
  mutable.seller.record.channel.payer = receiptAddress(7);
  mutable.buyer.record.sellerReceiptDigest = '77'.repeat(32);
  assert.deepEqual(await checking, f.receipt);
});
