// Exercises pure free receipt construction and independent observations with synthetic node signers only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFreeBuyerReceipt,
  buildFreeSellerReceipt,
  createFreeBuyerReceipt,
  createFreeSellerReceipt,
  receiptTextSizes,
  type ReceiptExecutionContext,
} from '@gyblos/core/receipts';
import {
  CONTROL_CODES,
  CONTROL_METERING_MODES,
  ENGINE_KINDS,
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
  OFFER_PRICING_KINDS,
  RECEIPT_OUTCOMES,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import { verifyReceipt, type SellerReceiptV1 } from '@gyblos/protocol/receipt';

import { buyerRecord, receiptSigner, sellerRecord } from './support/receipt-fixture';

function input(record = sellerRecord()) {
  return {
    ...context(record),
    engineKind: record.engineKind,
    metering: record.metering,
    usage: record.usage,
    sizes: record.sizes,
    timing: record.timing,
    outcome: record.outcome,
    code: record.code,
    reason: record.reason,
    finishReason: record.finishReason,
  };
}
function context(record: SellerReceiptV1): ReceiptExecutionContext {
  return {
    requestId: record.requestId,
    requestDigest: record.requestDigest,
    sellerNodeId: record.sellerNodeId,
    buyerNodeId: record.buyerNodeId,
    owner: record.owner,
    selection: record.selection,
    reasoning: record.reasoning,
    streaming: record.streaming,
  };
}
async function fixture() {
  const seller = receiptSigner();
  const buyer = receiptSigner();
  const record = sellerRecord(seller.nodeId, buyer.nodeId);
  const envelope = await createFreeSellerReceipt(input(record), seller.sign);
  return {
    seller, buyer, record, envelope,
    buyerInput: {
      seller: envelope.seller,
      context: context(record),
      observed: buyerRecord(record, record.requestDigest).observed,
    },
  };
}
void test('free seller builder fixes free amounts and detaches validated observations', () => {
  const source = input();
  const result = buildFreeSellerReceipt(source);
  assert.deepEqual(result, sellerRecord());
  source.usage.outputTokens = 99;
  source.selection.modelId = 'changed';
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.selection.modelId, 'synthetic/model');
});
void test('free seller builder rejects extra fields, paid overrides and estimates disguised as unknown usage', () => {
  for (const patch of [
    { prompt: 'synthetic-private-marker' },
    { pricing: { kind: OFFER_PRICING_KINDS.PAID } },
    { amountAtomic: '1' },
    { usage: { ...sellerRecord().usage, inputTokens: null } },
    { timing: { ...sellerRecord().timing, totalMs: -1 } },
    { code: FREE_EXECUTION_CODES.ENGINE },
  ]) assert.throws(() => buildFreeSellerReceipt({ ...input(), ...patch }), { code: CONTROL_CODES.INVALID });
});
void test('seller-only signed receipt remains unconfirmed and verifies without an expiry clock', async () => {
  const f = await fixture();
  assert.deepEqual(await verifyReceipt(f.envelope), f.envelope);
  assert.equal(Object.hasOwn(f.envelope, 'buyer'), false);
});
void test('seller creation refuses a signer from another NodeId', async () => {
  await assert.rejects(createFreeSellerReceipt(input(), receiptSigner().sign), { code: CONTROL_CODES.SIGNATURE });
});
void test('failed and cancelled receipts preserve measured partial usage and public stop reasons', async () => {
  const signer = receiptSigner();
  const base = input(sellerRecord(signer.nodeId));
  for (const terminal of [
    { outcome: RECEIPT_OUTCOMES.FAILED, code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE, reason: FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED },
    { outcome: RECEIPT_OUTCOMES.CANCELLED, code: FREE_EXECUTION_CODES.CANCELLED, reason: null },
  ]) {
    const value = await createFreeSellerReceipt({ ...base, ...terminal, finishReason: null }, signer.sign);
    assert.deepEqual((await verifyReceipt(value)).seller.record.usage, base.usage);
    assert.equal(value.seller.record.code, terminal.code);
  }
});
void test('buyer signs its own observations and linked seller digest', async () => {
  const f = await fixture();
  const value = await createFreeBuyerReceipt(f.buyerInput, f.buyer.sign);
  assert.deepEqual(await verifyReceipt(value), value);
  assert.equal(value.buyer?.record.verdict, RECEIPT_VERDICTS.AGREED);
  assert.equal(value.buyer?.record.observed.firstTokenMs, 14);
  assert.notEqual(value.buyer?.record.sellerReceiptDigest, f.record.requestDigest);
});
void test('buyer disputes only known unequal counts and bytes, in canonical order', async () => {
  const f = await fixture();
  const result = await buildFreeBuyerReceipt({ ...f.buyerInput, observed: { ...f.buyerInput.observed, inputTokens: 1, outputTokens: 2, outputBytes: 3 } });
  assert.equal(result.verdict, RECEIPT_VERDICTS.DISPUTED);
  assert.deepEqual(result.disputed, ['inputTokens', 'outputTokens', 'outputBytes']);
});
void test('unknown independent counts stay null even when seller declares usage', async () => {
  const f = await fixture();
  const result = await buildFreeBuyerReceipt({ ...f.buyerInput, observed: { ...f.buyerInput.observed, inputTokens: null, outputTokens: null } });
  assert.equal(result.observed.inputTokens, null);
  assert.equal(result.observed.outputTokens, null);
  assert.equal(result.verdict, RECEIPT_VERDICTS.AGREED);
  assert.deepEqual(result.disputed, []);
});
void test('buyer context binds every execution identity and exact selection before signing', async () => {
  const f = await fixture();
  let signed = 0;
  for (const patch of [
    { requestId: 'ab'.repeat(16) }, { requestDigest: 'ab'.repeat(32) },
    { sellerNodeId: 'ab'.repeat(32) }, { buyerNodeId: 'ab'.repeat(32) },
    { owner: 'SysvarRent111111111111111111111111111111111' },
    { selection: { ...f.record.selection, modelId: 'another' } },
    { selection: { ...f.record.selection, variant: 'another' } },
    { selection: { ...f.record.selection, quantization: 'Q8' } },
    { reasoning: 'low' }, { streaming: false },
  ]) await assert.rejects(createFreeBuyerReceipt({ ...f.buyerInput, context: { ...f.buyerInput.context, ...patch } }, async () => { signed++; return new Uint8Array(64); }), { code: CONTROL_CODES.POLICY });
  assert.equal(signed, 0);
});
void test('buyer rejects tampered seller signature before invoking its signer', async () => {
  const f = await fixture();
  let signed = false;
  await assert.rejects(createFreeBuyerReceipt({ ...f.buyerInput, seller: { ...f.buyerInput.seller, record: { ...f.record, usage: { ...f.record.usage, outputTokens: 6 } } } }, async () => { signed = true; return new Uint8Array(64); }), { code: CONTROL_CODES.SIGNATURE });
  assert.equal(signed, false);
});
void test('buyer rejects invalid observations, unknown fields and accessors without reading them', async () => {
  const f = await fixture();
  for (const value of [
    { ...f.buyerInput, response: 'synthetic-private-marker' },
    { ...f.buyerInput, context: { ...f.buyerInput.context, extra: 1 } },
    { ...f.buyerInput, observed: { ...f.buyerInput.observed, outputTokens: -1 } },
    { ...f.buyerInput, observed: { ...f.buyerInput.observed, totalMs: 1 } },
    { ...f.buyerInput, observed: { ...f.buyerInput.observed, outputBytes: 0 } },
  ]) await assert.rejects(buildFreeBuyerReceipt(value), { code: CONTROL_CODES.INVALID });
  let invoked = false;
  const hostile = { ...f.buyerInput };
  Object.defineProperty(hostile, 'context', { get() { invoked = true; throw new Error('synthetic'); } });
  await assert.rejects(buildFreeBuyerReceipt(hostile), { code: CONTROL_CODES.INVALID });
  assert.equal(invoked, false);
});
void test('buyer observations and context are snapshotted before asynchronous signature checks', async () => {
  const f = await fixture();
  const pending = buildFreeBuyerReceipt(f.buyerInput);
  f.buyerInput.observed.outputTokens = 99;
  f.buyerInput.context.selection.modelId = 'changed';
  const value = await pending;
  assert.equal(value.observed.outputTokens, 5);
  assert.equal(value.verdict, RECEIPT_VERDICTS.AGREED);
});
void test('receipt sizes count Unicode code points, not UTF16 units, without returning content', () => {
  assert.deepEqual(receiptTextSizes('a😀', 'é😀'), { inputBytes: 5, outputBytes: 6, inputChars: 2, outputChars: 2 });
  assert.deepEqual(receiptTextSizes('', ''), { inputBytes: 0, outputBytes: 0, inputChars: 0, outputChars: 0 });
});
void test('declared seller usage remains labelled declared and does not become buyer evidence', () => {
  const value = buildFreeSellerReceipt({ ...input(), engineKind: ENGINE_KINDS.OPENAI, metering: CONTROL_METERING_MODES.DECLARED });
  assert.equal(value.engineKind, ENGINE_KINDS.OPENAI);
  assert.equal(value.metering, CONTROL_METERING_MODES.DECLARED);
  assert.equal(value.usage.reasoningTokens, null);
});
