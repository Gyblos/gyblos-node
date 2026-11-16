// Protects bounded public receipt parsing and immutable signed snapshots across crypto awaits.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PUBLIC_RECEIPT_STATUSES as STATUSES } from '@gyblos/core/constants';
import { classifyPublicReceipt } from '@gyblos/core/public-receipts';
import {
  CONTROL_CODES,
  P2P_ROLES,
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
  RECEIPT_V2,
  sellerReceiptDigestV2,
  signBuyerReceiptV2,
  signSellerReceiptV2,
} from '@gyblos/protocol/receipt-v2';

import {
  buyerRecord,
  receiptSigner,
  sellerRecord,
} from './support/receipt-fixture';
import {
  receiptParserWork,
  wideReceiptRecord,
} from './support/receipt-parser-work';
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

async function paidReceipt(options: { disputed?: boolean } = {}) {
  const { seller, buyer, record } = paidReceiptFixture();
  const sellerHalf = await signSellerReceiptV2(record, seller.sign);
  const confirmation = paidBuyerRecord(
    record,
    await sellerReceiptDigestV2(record),
  );
  if (options.disputed) {
    confirmation.observed.outputTokens = record.usage.outputTokens + 1;
    confirmation.verdict = RECEIPT_VERDICTS.DISPUTED;
    confirmation.disputed = [RECEIPT_DISPUTE_FIELDS.OUTPUT_TOKENS];
  }
  const buyerHalf = await signBuyerReceiptV2(confirmation, buyer.sign);
  return { seller, buyer, record, sellerHalf, buyerHalf };
}

const invalidControl = (error: unknown) =>
  error instanceof ControlError && error.code === CONTROL_CODES.INVALID;

for (const boundary of ['receipt', 'seller'] as const) {
  void test(`public receipt rejects a wide ${boundary} envelope with linear work`, async (t) => {
    const fixture = await freeReceipt();
    const record = wideReceiptRecord(
      boundary === 'receipt'
        ? { seller: fixture.sellerHalf }
        : fixture.sellerHalf,
    );
    const value = boundary === 'receipt' ? record : { seller: record };
    const linearWork = receiptParserWork(t, record);
    const verify = t.mock.method(crypto.subtle, 'verify');
    await assert.rejects(classifyPublicReceipt(value), invalidControl);
    assert.equal(verify.mock.callCount(), 0);
    linearWork();
  });
}

for (const version of [RECEIPT.version, RECEIPT_V2.version]) {
  for (const side of Object.values(P2P_ROLES)) {
    void test(`public receipt rejects wide v${version} ${side} records before crypto with linear work`, async (t) => {
      const fixture =
        version === RECEIPT.version ? await freeReceipt() : await paidReceipt();
      const half =
        side === P2P_ROLES.SELLER ? fixture.sellerHalf : fixture.buyerHalf;
      const record = wideReceiptRecord(half.record);
      const value = {
        seller: fixture.sellerHalf,
        buyer: fixture.buyerHalf,
        [side]: { ...half, record },
      };
      const linearWork = receiptParserWork(t, record);
      const verify = t.mock.method(crypto.subtle, 'verify');
      await assert.rejects(classifyPublicReceipt(value), invalidControl);
      assert.equal(verify.mock.callCount(), 0);
      linearWork();
    });
  }

  void test(`public receipt snapshots the v${version} buyer observation before crypto yields`, async () => {
    const fixture =
      version === RECEIPT.version ? await freeReceipt() : await paidReceipt();
    const original = { seller: fixture.sellerHalf, buyer: fixture.buyerHalf };
    const value = structuredClone(original);
    const pending = classifyPublicReceipt(value);
    value.buyer.record.observed.totalMs += 1;
    assert.deepEqual((await pending).receipt, original);
  });

  void test(`public receipt preserves a v${version} dispute when a later agreed half replaces the input`, async () => {
    const fixture =
      version === RECEIPT.version
        ? await freeReceipt({ disputed: true })
        : await paidReceipt({ disputed: true });
    const record = fixture.record;
    const agreed =
      record.version === RECEIPT.version
        ? await signBuyerReceipt(
            buyerRecord(record, await sellerReceiptDigest(record)),
            fixture.buyer.sign,
          )
        : await signBuyerReceiptV2(
            paidBuyerRecord(record, await sellerReceiptDigestV2(record)),
            fixture.buyer.sign,
          );
    const value = { seller: fixture.sellerHalf, buyer: fixture.buyerHalf };
    const pending = classifyPublicReceipt(value);
    value.buyer = agreed;
    const entry = await pending;
    assert.equal(entry.status, STATUSES.DISPUTED);
    assert.deepEqual(entry.receipt.buyer, fixture.buyerHalf);
  });
}
