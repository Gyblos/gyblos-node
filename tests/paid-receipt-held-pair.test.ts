// Cryptographically valid retained attestations must still match independent paid usage before confirmation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVNET } from '@gyblos/config';
import type { BuyerReceiptEvidence } from '@gyblos/node/receipts';
import {
  OFFER_PRICING_KINDS,
  RECEIPT_DISPUTE_FIELDS,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import {
  sellerReceiptDigest,
  signBuyerReceipt,
  signSellerReceipt,
} from '@gyblos/protocol/receipt';

import { nativeFreeReceiptFixture } from './support/free-receipts';
import { NATIVE_CAPABILITY } from './support/native-runtime';
import { buyerRecord, sellerRecord } from './support/receipt-fixture';

async function paidPairFixture() {
  const f = await nativeFreeReceiptFixture();
  const record = {
    ...sellerRecord(f.seller.id().toString(), f.buyer.id().toString()),
    pricing: {
      kind: OFFER_PRICING_KINDS.PAID,
      prices: { inputAtomicPerMtok: '1000000', outputAtomicPerMtok: '1000000' },
      network: DEVNET,
      asset: '11111111111111111111111111111111',
    },
    amountAtomic: '12',
    feeAtomic: '1',
  };
  const seller = await signSellerReceipt(record, async (bytes) =>
    Uint8Array.from(
      f.seller
        .secretKey()
        .sign([...bytes])
        .toBytes(),
    ),
  );
  const buyer = buyerRecord(record, await sellerReceiptDigest(record));
  const {
    requestId,
    requestDigest,
    sellerNodeId,
    buyerNodeId,
    owner,
    selection,
    reasoning,
    streaming,
  } = record;
  const evidence: BuyerReceiptEvidence = {
    context: {
      requestId,
      requestDigest,
      sellerNodeId,
      buyerNodeId,
      owner,
      selection,
      reasoning,
      streaming,
    },
    observed: { ...buyer.observed, firstTokenMs: 20, totalMs: 80 },
    payment: {
      pricing: record.pricing,
      amountAtomic: record.amountAtomic,
      feeAtomic: record.feeAtomic,
    },
    metering: record.metering,
  };
  return {
    f,
    seller,
    buyer,
    evidence,
    sign: async (bytes: Uint8Array) =>
      Uint8Array.from(
        f.buyer
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      ),
  };
}

void test(
  'paid receipt runtime refuses retained unknown or disputed buyer observations from remote and local stores',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    for (const remote of [false, true])
      for (const disputed of [false, true]) {
        const { f, seller, buyer, evidence, sign } = await paidPairFixture();
        try {
          const changed = {
            ...buyer,
            observed: { ...buyer.observed, inputTokens: disputed ? 99 : null },
            verdict: disputed
              ? RECEIPT_VERDICTS.DISPUTED
              : RECEIPT_VERDICTS.AGREED,
            disputed: disputed ? [RECEIPT_DISPUTE_FIELDS.INPUT_TOKENS] : [],
          };
          const held = { seller, buyer: await signBuyerReceipt(changed, sign) };
          await f.sellerStore.put(remote ? held : { seller });
          if (!remote) await f.buyerStore.put(held);
          let saved = 0;
          let confirmed = 0;
          const put = f.buyerStore.put.bind(f.buyerStore);
          const confirm = f.sellerStore.confirm.bind(f.sellerStore);
          f.buyerStore.put = async (...args) => {
            saved++;
            return put(...args);
          };
          f.sellerStore.confirm = async (...args) => {
            confirmed++;
            return confirm(...args);
          };
          f.buyerReceipts.exchange(f.seller.addr(), evidence);
          await f.buyerReceipts.settled();
          assert.equal(
            f.buyerReceipts.health().saved,
            0,
            `remote=${remote}, disputed=${disputed}`,
          );
          assert.equal(f.buyerReceipts.health().failed, 1);
          assert.equal(saved, 0);
          assert.equal(confirmed, 0);
          assert.equal(f.calls(), 0);
        } finally {
          await f.close();
        }
      }
  },
);

void test(
  'paid receipt confirmation reuses a matching retained pair with its original timing',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async () => {
    const { f, seller, buyer, evidence, sign } = await paidPairFixture();
    try {
      const held = { seller, buyer: await signBuyerReceipt(buyer, sign) };
      await f.sellerStore.put(held);
      f.buyerReceipts.exchange(f.seller.addr(), evidence);
      await f.buyerReceipts.settled();
      assert.equal(f.buyerReceipts.health().saved, 1);
      assert.equal(f.calls(), 0);
    } finally {
      await f.close();
    }
  },
);
