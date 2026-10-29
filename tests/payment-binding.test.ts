// Pins the payment terms digest, the on-chain memo and the protocol fee arithmetic.
// The digest vector was computed independently (Python json sort_keys + hashlib.sha256).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAYMENT_BINDING,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError, type PaymentTerms } from '@gyblos/protocol/payment';
import {
  feeSplitBps,
  grossAtomicPerMtok,
  paymentMemo,
  paymentTermsDigest,
} from '@gyblos/protocol/payment-binding';

const TERMS: PaymentTerms = {
  buyer: 'Buyer1111111111111111111111111111111111111',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  mint: 'Mint11111111111111111111111111111111111111',
  payTo: 'PayTo1111111111111111111111111111111111111',
  feePayer: 'FeePayer11111111111111111111111111111111111',
  authorizer: 'Authorizer111111111111111111111111111111111',
  requestDigest: 'ab'.repeat(32),
  maxAtomic: '1030000',
  expiresAt: 1_800_000_060_000,
  protocolFeeBps: 300,
  treasury: 'Treasury111111111111111111111111111111111111',
};
const DIGEST =
  '89cd3f9fb5e92462f3b92f70f16b0fa047642732c396a97da0a9756df7ecdfb4';

function rejectsCode(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof PaymentError);
    assert.equal(error.code, code);
    return true;
  });
}

void test('the terms digest commits to every money field under its own domain', async () => {
  assert.equal(await paymentTermsDigest(TERMS), DIGEST);
  for (const [key, value] of Object.entries({
    buyer: TERMS.payTo,
    network: 'solana:other',
    mint: TERMS.payTo,
    payTo: TERMS.buyer,
    feePayer: TERMS.buyer,
    authorizer: TERMS.buyer,
    requestDigest: 'cd'.repeat(32),
    maxAtomic: '1030001',
    expiresAt: TERMS.expiresAt + 1,
    protocolFeeBps: 299,
    treasury: TERMS.payTo,
  }))
    assert.notEqual(
      await paymentTermsDigest({ ...TERMS, [key]: value }),
      DIGEST,
      key,
    );
});

void test('the memo is the prefixed digest and fits the 256-byte on-chain memo', async () => {
  const memo = await paymentMemo(TERMS);
  assert.equal(memo, `${PAYMENT_BINDING.memoPrefix}${DIGEST}`);
  assert.ok(new TextEncoder().encode(memo).length <= PAYMENT_BINDING.memoBytes);
});

void test('the fee is added on top of the seller price and the split favours the seller', () => {
  assert.deepEqual(feeSplitBps(300), { sellerBps: 9709, treasuryBps: 291 });
  assert.deepEqual(feeSplitBps(0), { sellerBps: 10_000, treasuryBps: 0 });
  assert.equal(grossAtomicPerMtok('1000000', 300), '1030000');
  assert.equal(grossAtomicPerMtok('0', 300), '0');
  assert.equal(grossAtomicPerMtok('1', 300), '2');
  assert.equal(grossAtomicPerMtok('1000000', 0), '1000000');
  // For every fee the seller's share of the gross price never falls below its own price.
  for (const fee of [1, 50, 300, 999, PAYMENT_BINDING.maxFeeBps])
    for (const net of [1n, 7n, 999_999n, 1_000_000n, 123_456_789n]) {
      const gross = BigInt(grossAtomicPerMtok(String(net), fee));
      const { sellerBps } = feeSplitBps(fee);
      assert.ok((gross * BigInt(sellerBps)) / 10_000n >= net, `${fee} ${net}`);
    }
});

void test('fees and prices outside policy are refused with a static code', async () => {
  for (const fee of [-1, 1.5, PAYMENT_BINDING.maxFeeBps + 1])
    rejectsCode(() => feeSplitBps(fee), PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
  for (const price of ['-1', '01', '1.5', ''])
    rejectsCode(
      () => grossAtomicPerMtok(price, 300),
      PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
    );
  await assert.rejects(
    paymentTermsDigest({ ...TERMS, protocolFeeBps: 1.5 }),
    PaymentError,
  );
});
