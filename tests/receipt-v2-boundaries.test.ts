// Checks paid receipt boundaries, detached signing and domain isolation with ephemeral synthetic keys.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  PUBLIC_RECORD_LIMITS,
  RECEIPT,
} from '@gyblos/protocol/constants';
import { settlementShares } from '@gyblos/protocol/payment-binding';
import {
  parseBuyerReceiptV2,
  parseSellerReceiptV2,
  sellerReceiptDigestV2,
  signBuyerReceiptV2,
  signSellerReceiptV2,
  verifyReceiptV2,
} from '@gyblos/protocol/receipt-v2';
import { signingBytes } from '@gyblos/protocol/signing';

import {
  paidBuyerRecord,
  paidReceiptFixture,
  paidRecord,
  receiptAddress,
} from './support/receipt-v2';

void test('paid receipt/v2 rejects missing, extra, hostile and malformed common fields', () => {
  const record = paidRecord();
  const { channel: _channel, ...missing } = record;
  let read = false;
  const getter = { ...record };
  Object.defineProperty(getter, 'channel', {
    enumerable: true,
    get() {
      read = true;
      return record.channel;
    },
  });
  for (const value of [
    missing,
    getter,
    null,
    [],
    { ...record, prompt: 'synthetic-excluded' },
    { ...record, channel: null },
    { ...record, requestId: 'FF'.repeat(16) },
    { ...record, channel: { ...record.channel, baseAtomic: '-1' } },
    { ...record, channel: { ...record.channel, cumulativeAtomic: 70 } },
    { ...record, channel: { ...record.channel, cumulativeAtomic: '7e1' } },
    { ...record, channel: { ...record.channel, cumulativeAtomic: ' 70' } },
    { ...record, channel: { ...record.channel, baseAtomic: '1'.repeat(4096) } },
  ])
    assert.throws(() => parseSellerReceiptV2(value), {
      code: CONTROL_CODES.INVALID,
    });
  assert.equal(read, false);
});
void test('paid receipt/v2 handles the u64 cumulative boundary without Number arithmetic', () => {
  const record = paidRecord();
  const end = BigInt(PUBLIC_RECORD_LIMITS.maxAtomic);
  const start = end - BigInt(record.amountAtomic);
  const fee =
    BigInt(
      settlementShares(String(end), record.channel.protocolFeeBps).feeAtomic,
    ) -
    BigInt(
      settlementShares(String(start), record.channel.protocolFeeBps).feeAtomic,
    );
  const parsed = parseSellerReceiptV2({
    ...record,
    feeAtomic: String(fee),
    channel: {
      ...record.channel,
      baseAtomic: String(start),
      cumulativeAtomic: String(end),
    },
  });
  assert.equal(parsed.channel.cumulativeAtomic, PUBLIC_RECORD_LIMITS.maxAtomic);
  assert.equal(parsed.amountAtomic, '70');
  assert.equal(parsed.feeAtomic, '3');
  assert.throws(
    () =>
      parseSellerReceiptV2({
        ...record,
        channel: { ...record.channel, cumulativeAtomic: String(end + 1n) },
      }),
    { code: CONTROL_CODES.INVALID },
  );
});
void test('paid receipt/v2 refuses malformed records before invoking a signer', async () => {
  const record = paidRecord();
  let calls = 0;
  await assert.rejects(
    async () =>
      signSellerReceiptV2(
        {
          ...record,
          channel: { ...record.channel, payer: 'synthetic-invalid' },
        },
        async () => {
          calls++;
          return new Uint8Array(64);
        },
      ),
    { code: CONTROL_CODES.INVALID },
  );
  assert.equal(calls, 0);
});
void test('paid receipt/v2 signs detached seller and buyer records across asynchronous callbacks', async () => {
  const f = paidReceiptFixture();
  const before = structuredClone(f.record);
  let resume = () => {};
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const pending = signSellerReceiptV2(f.record, async (bytes) => {
    await waiting;
    return f.seller.sign(bytes);
  });
  f.record.channel.payer = receiptAddress(7);
  f.record.usage.outputTokens = 999;
  resume();
  const seller = await pending;
  assert.deepEqual(seller.record, before);
  const observation = paidBuyerRecord(
    before,
    await sellerReceiptDigestV2(before),
  );
  const original = structuredClone(observation);
  const buyer = signBuyerReceiptV2(observation, async (bytes) => {
    observation.sellerReceiptDigest = '77'.repeat(32);
    return f.buyer.sign(bytes);
  });
  assert.deepEqual((await buyer).record, original);
  assert.deepEqual((await verifyReceiptV2({ seller })).seller.record, before);
});
void test('paid receipt/v2 rejects a valid signature over the same record under a v1 domain', async () => {
  const f = paidReceiptFixture();
  const signature = Buffer.from(
    await f.seller.sign(signingBytes(RECEIPT.sellerDomain, f.record)),
  ).toString('hex');
  await assert.rejects(
    verifyReceiptV2({ seller: { record: f.record, signature } }),
    {
      code: CONTROL_CODES.SIGNATURE,
    },
  );
});
void test('paid receipt/v2 keeps buyer unknown-field, dispute and signature bounds strict', async () => {
  const f = paidReceiptFixture();
  const record = paidBuyerRecord(
    f.record,
    await sellerReceiptDigestV2(f.record),
  );
  for (const patch of [
    { extra: 1 },
    { channel: f.record.channel },
    { observed: { ...record.observed, totalMs: NaN } },
    { disputed: ['outputTokens', 'outputTokens'] },
  ])
    assert.throws(() => parseBuyerReceiptV2({ ...record, ...patch }), {
      code: CONTROL_CODES.INVALID,
    });
  const seller = await signSellerReceiptV2(f.record, f.seller.sign);
  await assert.rejects(
    verifyReceiptV2({ seller: { ...seller, signature: '00' } }),
    { code: CONTROL_CODES.INVALID },
  );
  await assert.rejects(verifyReceiptV2({ seller, buyer: undefined }), {
    code: CONTROL_CODES.INVALID,
  });
});
