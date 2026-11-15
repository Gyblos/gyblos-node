// Paid usage attestations bind independent authorization evidence, never claim that settlement occurred.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVNET } from '@gyblos/config';
import {
  buildFreeSellerReceipt,
  buildPaidBuyerReceipt,
  buildPaidSellerReceipt,
  createFreeBuyerReceipt,
  createPaidBuyerReceipt,
  createPaidSellerReceipt,
  type FreeSellerReceiptInput,
  type PaidReceiptPayment,
} from '@gyblos/core/receipts';
import {
  CONTROL_CODES,
  CONTROL_METERING_MODES,
  FREE_EXECUTION_CODES,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
  RECEIPT_OUTCOMES,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import { signSellerReceipt, verifyReceipt } from '@gyblos/protocol/receipt';

import {
  buyerRecord,
  receiptSigner,
  sellerRecord,
} from './support/receipt-fixture';

const ALTERNATIVE_ADDRESS = '1'.repeat(31) + '2';

function fixture() {
  const seller = receiptSigner();
  const buyer = receiptSigner();
  const base = sellerRecord(seller.nodeId, buyer.nodeId);
  const context = {
    requestId: base.requestId,
    requestDigest: base.requestDigest,
    sellerNodeId: base.sellerNodeId,
    buyerNodeId: base.buyerNodeId,
    owner: base.owner,
    selection: base.selection,
    reasoning: base.reasoning,
    streaming: base.streaming,
  };
  const record: FreeSellerReceiptInput = {
    ...context,
    engineKind: base.engineKind,
    metering: base.metering,
    usage: base.usage,
    sizes: base.sizes,
    timing: base.timing,
    outcome: base.outcome,
    code: base.code,
    reason: base.reason,
    finishReason: base.finishReason,
  };
  const payment: PaidReceiptPayment = {
    pricing: {
      kind: OFFER_PRICING_KINDS.PAID,
      prices: { inputAtomicPerMtok: '1000000', outputAtomicPerMtok: '1000000' },
      network: DEVNET,
      asset: base.owner,
    },
    amountAtomic: '12',
    feeAtomic: '1',
  };
  const expected = { ...base, ...payment };
  return {
    seller,
    buyer,
    context,
    record,
    payment,
    expected,
    observed: buyerRecord(expected, expected.requestDigest).observed,
  };
}
void test('paid seller policy signs exact per-request authorized amounts with detached observations', async () => {
  const f = fixture();
  const record = buildPaidSellerReceipt({
    record: f.record,
    payment: f.payment,
  });
  assert.deepEqual(record, f.expected);
  f.payment.amountAtomic = '999';
  f.record.usage.outputTokens = 99;
  assert.equal(record.amountAtomic, '12');
  assert.equal(record.usage.outputTokens, 5);
  const fresh = fixture();
  const envelope = await createPaidSellerReceipt(
    { record: fresh.record, payment: fresh.payment },
    fresh.seller.sign,
  );
  assert.deepEqual(
    (await verifyReceipt(envelope)).seller.record,
    fresh.expected,
  );
});
void test('paid buyer signs only independently matched usage and authorization fields', async () => {
  const f = fixture();
  const seller = await signSellerReceipt(f.expected, f.seller.sign);
  const input = {
    seller,
    context: f.context,
    observed: f.observed,
    payment: f.payment,
  };
  assert.equal(
    (await buildPaidBuyerReceipt(input)).verdict,
    RECEIPT_VERDICTS.AGREED,
  );
  const pair = await createPaidBuyerReceipt(input, f.buyer.sign);
  assert.ok((await verifyReceipt(pair)).buyer);
  await assert.rejects(
    createFreeBuyerReceipt(
      { seller, context: f.context, observed: f.observed },
      f.buyer.sign,
    ),
    { code: CONTROL_CODES.POLICY },
  );
});
void test('paid seller policy refuses incomplete or estimated execution and inconsistent amounts', () => {
  const f = fixture();
  for (const record of [
    { ...f.record, metering: CONTROL_METERING_MODES.DECLARED },
    {
      ...f.record,
      outcome: RECEIPT_OUTCOMES.FAILED,
      code: FREE_EXECUTION_CODES.ENGINE,
      finishReason: null,
    },
  ])
    assert.throws(
      () => buildPaidSellerReceipt({ record, payment: f.payment }),
      { code: CONTROL_CODES.POLICY },
    );
  assert.throws(
    () =>
      buildPaidSellerReceipt({
        record: f.record,
        payment: { ...f.payment, amountAtomic: '13' },
      }),
    { code: CONTROL_CODES.POLICY },
  );
  assert.throws(
    () =>
      buildPaidSellerReceipt({
        record: f.record,
        payment: { ...f.payment, feeAtomic: '13' },
      }),
    { code: CONTROL_CODES.INVALID },
  );
  assert.deepEqual(buildFreeSellerReceipt(f.record).pricing, {
    kind: OFFER_PRICING_KINDS.FREE,
  });
});
void test('a valid seller signature never lets changed receipt fields reach the paid buyer signer', async () => {
  const f = fixture();
  const mutations = [
    { requestId: '99'.repeat(16) },
    { requestDigest: '77'.repeat(32) },
    { buyerNodeId: '88'.repeat(32) },
    { owner: ALTERNATIVE_ADDRESS },
    { selection: { ...f.expected.selection, modelId: 'other/model' } },
    { streaming: false },
    { reasoning: REASONING_LEVELS.LOW },
    { amountAtomic: '11' },
    { feeAtomic: '0' },
    { pricing: { ...f.payment.pricing, asset: ALTERNATIVE_ADDRESS } },
    {
      pricing: {
        ...f.payment.pricing,
        prices: { ...f.payment.pricing.prices, outputAtomicPerMtok: '2000000' },
      },
    },
    { metering: CONTROL_METERING_MODES.DECLARED },
    { usage: { ...f.expected.usage, outputTokens: 6 } },
    { sizes: { ...f.expected.sizes, outputBytes: 13 } },
  ];
  let signed = 0;
  for (const mutation of mutations) {
    const seller = await signSellerReceipt(
      { ...f.expected, ...mutation },
      f.seller.sign,
    );
    await assert.rejects(
      createPaidBuyerReceipt(
        {
          seller,
          context: f.context,
          observed: f.observed,
          payment: f.payment,
        },
        async (bytes) => {
          signed++;
          return f.buyer.sign(bytes);
        },
      ),
      { code: CONTROL_CODES.POLICY },
    );
  }
  assert.equal(signed, 0);
});
void test('paid buyer requires independently recounted tokens and refuses unknown authorization fields before signing', async () => {
  const f = fixture();
  const seller = await signSellerReceipt(f.expected, f.seller.sign);
  let signed = 0;
  const signer = async (bytes: Uint8Array) => {
    signed++;
    return f.buyer.sign(bytes);
  };
  for (const observed of [
    { ...f.observed, inputTokens: null },
    { ...f.observed, outputTokens: null },
    { ...f.observed, inputTokens: f.expected.usage.inputTokens + 1 },
  ]) {
    await assert.rejects(
      createPaidBuyerReceipt(
        { seller, context: f.context, observed, payment: f.payment },
        signer,
      ),
      { code: CONTROL_CODES.POLICY },
    );
  }
  await assert.rejects(
    createPaidBuyerReceipt(
      {
        seller,
        context: f.context,
        observed: f.observed,
        payment: { ...f.payment, settled: true },
      },
      signer,
    ),
    { code: CONTROL_CODES.INVALID },
  );
  assert.equal(signed, 0);
});
void test('paid buyer refuses a valid receipt whose amount differs from its own terminal authorization', async () => {
  const f = fixture();
  const seller = await signSellerReceipt(f.expected, f.seller.sign);
  let signed = 0;
  await assert.rejects(
    createPaidBuyerReceipt(
      {
        seller,
        context: f.context,
        observed: f.observed,
        payment: { ...f.payment, amountAtomic: '11' },
      },
      async (bytes) => {
        signed++;
        return f.buyer.sign(bytes);
      },
    ),
    { code: CONTROL_CODES.POLICY },
  );
  assert.equal(signed, 0);
});
void test('paid receipt policy preserves zero-output charging and text-free tool usage', () => {
  const f = fixture();
  const empty = {
    ...f.record,
    usage: { ...f.record.usage, outputTokens: 0 },
    sizes: { ...f.record.sizes, outputBytes: 0, outputChars: 0 },
    timing: { ...f.record.timing, firstTokenMs: null },
  };
  assert.equal(
    buildPaidSellerReceipt({
      record: empty,
      payment: { ...f.payment, amountAtomic: '0', feeAtomic: '0' },
    }).amountAtomic,
    '0',
  );
  assert.equal(
    buildPaidSellerReceipt({
      record: { ...empty, usage: f.record.usage },
      payment: f.payment,
    }).usage.outputTokens,
    5,
  );
});
void test('paid verification snapshots caller-owned financial fields before cryptographic work yields', async () => {
  const f = fixture();
  const seller = await signSellerReceipt(f.expected, f.seller.sign);
  const pending = createPaidBuyerReceipt(
    { seller, context: f.context, observed: f.observed, payment: f.payment },
    f.buyer.sign,
  );
  f.payment.amountAtomic = '999';
  f.payment.pricing.prices.outputAtomicPerMtok = '999';
  assert.ok((await verifyReceipt(await pending)).buyer);
});
