// Checks strict content-free receipt parsing, signatures and linkage with synthetic node keys only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  FREE_EXECUTION_CODES,
  RECEIPT_OUTCOMES,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import {
  parseBuyerReceipt,
  parseSellerReceipt,
  sellerReceiptDigest,
  signBuyerReceipt,
  signSellerReceipt,
  verifyReceipt,
} from '@gyblos/protocol/receipt';

import {
  buyerRecord,
  receiptSigner,
  sellerRecord,
} from './support/receipt-fixture';

void test('receipt parses detached seller and buyer records', () => {
  const seller = sellerRecord();
  assert.deepEqual(parseSellerReceipt(seller), seller);
  assert.notEqual(parseSellerReceipt(seller).sizes, seller.sizes);
  const buyer = buyerRecord(seller, '66'.repeat(32));
  assert.deepEqual(parseBuyerReceipt(buyer), buyer);
});
void test('receipts self-verify node signatures, buyer digest and identity without an expiry clock', async () => {
  const seller = receiptSigner();
  const buyer = receiptSigner();
  const record = sellerRecord(seller.nodeId, buyer.nodeId);
  const envelope = {
    seller: await signSellerReceipt(record, seller.sign),
    buyer: await signBuyerReceipt(
      buyerRecord(record, await sellerReceiptDigest(record)),
      buyer.sign,
    ),
  };
  assert.deepEqual(await verifyReceipt(envelope), envelope);
  assert.deepEqual(await verifyReceipt({ seller: envelope.seller }), {
    seller: envelope.seller,
  });
  await assert.rejects(signSellerReceipt(record, buyer.sign), {
    code: CONTROL_CODES.SIGNATURE,
  });
  await assert.rejects(signBuyerReceipt(envelope.buyer.record, seller.sign), {
    code: CONTROL_CODES.SIGNATURE,
  });
  await assert.rejects(
    verifyReceipt({
      ...envelope,
      seller: { ...envelope.seller, signature: '00'.repeat(64) },
    }),
    { code: CONTROL_CODES.SIGNATURE },
  );
  for (const patch of [
    { requestId: '77'.repeat(16) },
    { sellerNodeId: '77'.repeat(32) },
    { sellerReceiptDigest: '77'.repeat(32) },
  ]) {
    const changed = await signBuyerReceipt(
      { ...envelope.buyer.record, ...patch },
      buyer.sign,
    );
    await assert.rejects(
      verifyReceipt({ seller: envelope.seller, buyer: changed }),
      { code: CONTROL_CODES.POLICY },
    );
  }
  await assert.rejects(
    verifyReceipt({ ...envelope, prompt: 'PROMPT-SECRET-MARKER' }),
    { code: CONTROL_CODES.INVALID },
  );
  await assert.rejects(
    verifyReceipt({ seller: envelope.seller, buyer: undefined }),
    { code: CONTROL_CODES.INVALID },
  );
});
void test('seller receipt rejects malformed shape, amounts, times and outcome invariants', () => {
  const base = sellerRecord();
  const invalid = [
    { ...base, prompt: 'PROMPT-SECRET-MARKER' },
    { ...base, reason: undefined },
    { ...base, requestId: 'AA'.repeat(16) },
    { ...base, requestDigest: '00' },
    { ...base, amountAtomic: '00' },
    { ...base, amountAtomic: '1' },
    { ...base, feeAtomic: '1' },
    { ...base, timing: { ...base.timing, firstTokenMs: 41 } },
    { ...base, timing: { ...base.timing, firstTokenMs: null } },
    { ...base, sizes: { ...base.sizes, outputBytes: 0 } },
    { ...base, usage: { ...base.usage, inputTokens: -1 } },
    { ...base, usage: { ...base.usage, reasoningTokens: 1.5 } },
    {
      ...base,
      sizes: { ...base.sizes, outputChars: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      ...base,
      outcome: RECEIPT_OUTCOMES.COMPLETED,
      code: FREE_EXECUTION_CODES.ENGINE,
    },
    { ...base, outcome: RECEIPT_OUTCOMES.COMPLETED, finishReason: null },
    { ...base, outcome: RECEIPT_OUTCOMES.FAILED },
    {
      ...base,
      outcome: RECEIPT_OUTCOMES.CANCELLED,
      code: FREE_EXECUTION_CODES.ENGINE,
    },
    { ...base, usage: { ...base.usage, prompt: 'PROMPT-SECRET-MARKER' } },
    {
      ...base,
      pricing: {
        kind: 'paid',
        prices: { inputAtomicPerMtok: '1', outputAtomicPerMtok: '2' },
        network: 'solana:synthetic',
        asset: base.owner,
      },
      amountAtomic: '1',
      feeAtomic: '2',
    },
  ];
  for (const value of invalid)
    assert.throws(() => parseSellerReceipt(value), {
      code: CONTROL_CODES.INVALID,
    });
  assert.equal(
    parseSellerReceipt({
      ...base,
      outcome: RECEIPT_OUTCOMES.CANCELLED,
      code: FREE_EXECUTION_CODES.CANCELLED,
    }).code,
    FREE_EXECUTION_CODES.CANCELLED,
  );
  assert.equal(
    parseSellerReceipt({
      ...base,
      outcome: RECEIPT_OUTCOMES.FAILED,
      code: FREE_EXECUTION_CODES.ENGINE,
    }).code,
    FREE_EXECUTION_CODES.ENGINE,
  );
});
void test('buyer receipt enforces dispute order, verdict equivalence and nullable metering', () => {
  const base = buyerRecord(sellerRecord(), '66'.repeat(32));
  for (const patch of [
    { verdict: RECEIPT_VERDICTS.DISPUTED },
    { disputed: ['inputTokens'] },
    {
      verdict: RECEIPT_VERDICTS.DISPUTED,
      disputed: ['outputBytes', 'inputTokens'],
    },
    {
      verdict: RECEIPT_VERDICTS.DISPUTED,
      disputed: ['outputTokens', 'outputTokens'],
    },
    { verdict: RECEIPT_VERDICTS.DISPUTED, disputed: ['firstTokenMs'] },
    { observed: { ...base.observed, firstTokenMs: null } },
    { observed: { ...base.observed, outputTokens: undefined } },
    { observed: { ...base.observed, extra: 1 } },
  ])
    assert.throws(() => parseBuyerReceipt({ ...base, ...patch }), {
      code: CONTROL_CODES.INVALID,
    });
  assert.deepEqual(
    parseBuyerReceipt({
      ...base,
      observed: { ...base.observed, inputTokens: null, outputTokens: null },
    }).observed.inputTokens,
    null,
  );
});
