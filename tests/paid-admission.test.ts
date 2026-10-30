// Single use and generation slots for paid requests; synthetic requests and clock, no payments.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PAID_EXECUTION_ADMISSION } from '@gyblos/core/constants';
import { PaidSellerLedger } from '@gyblos/core/paid-admission';
import type { PaidExecutionRequest } from '@gyblos/protocol/paid-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { refusedWith, request } from './support/paid-fixture';

function withId(paid: PaidExecutionRequest, requestId: string) {
  return {
    ...paid,
    quote: { ...paid.quote, offer: { ...paid.quote.offer, requestId } },
  };
}

void test('a paid request is used once until its quote expires', async () => {
  const paid = await request();
  const offer = paid.quote.offer;
  const ledger = new PaidSellerLedger(offer.issuedAt - 1);
  const release = ledger.admit(paid, offer.issuedAt);
  release();
  assert.throws(
    () => ledger.admit(paid, offer.issuedAt),
    refusedWith(PAID_EXECUTION_CODES.REPLAY),
  );
  assert.throws(
    () => ledger.admit(paid, offer.expiresAt),
    refusedWith(PAID_EXECUTION_CODES.EXPIRED),
  );
});

void test('quotes issued before the seller started, or not yet valid, are expired', async () => {
  const paid = await request();
  const offer = paid.quote.offer;
  assert.throws(
    () => new PaidSellerLedger(offer.issuedAt).admit(paid, offer.issuedAt),
    refusedWith(PAID_EXECUTION_CODES.EXPIRED),
  );
  assert.throws(
    () =>
      new PaidSellerLedger(offer.issuedAt - 2).admit(paid, offer.issuedAt - 1),
    refusedWith(PAID_EXECUTION_CODES.EXPIRED),
  );
});

void test('generation slots are bounded and released once', async () => {
  const paid = await request();
  const now = paid.quote.offer.issuedAt;
  const ledger = new PaidSellerLedger(now - 1);
  const releases = Array.from(
    { length: PAID_EXECUTION_ADMISSION.maxConcurrent },
    (_value, index) =>
      ledger.admit(withId(paid, String(index).padStart(32, '0')), now),
  );
  assert.throws(
    () => ledger.admit(withId(paid, 'f'.repeat(32)), now),
    refusedWith(PAID_EXECUTION_CODES.BUSY),
  );
  releases[0]!();
  releases[0]!();
  ledger.admit(withId(paid, 'e'.repeat(32)), now);
  assert.throws(
    () => ledger.admit(withId(paid, 'd'.repeat(32)), now),
    refusedWith(PAID_EXECUTION_CODES.BUSY),
  );
});
