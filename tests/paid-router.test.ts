// Routes paid requests by the quoted selection; an unknown selection is refused before any service runs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSellerPaidRouter } from '@gyblos/node/paid-router';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { paidSellerFixture } from './support/paid-seller';

void test('the router serves the quoted selection and refuses any other', async () => {
  const seller = await paidSellerFixture();
  const paid = await seller.request();
  const signal = new AbortController().signal;
  const peer = paid.quote.offer.buyerNodeId;
  const routed = createSellerPaidRouter(() => [
    { selection: paid.quote.offer.selection, service: seller.service },
  ]);
  const served = await routed.stream(paid, peer, signal, async () => {});
  assert.equal(served.result?.text, 'Hi.');
  const other = createSellerPaidRouter(() => [
    {
      selection: { ...paid.quote.offer.selection, variant: 'other' },
      service: seller.service,
    },
  ]);
  const unserved = await other.stream(paid, peer, signal, async () => {});
  assert.equal(unserved.error?.code, PAID_EXECUTION_CODES.UNSUPPORTED);
  const empty = createSellerPaidRouter(() => []);
  const refused = await empty.stream(paid, peer, signal, async () => {});
  assert.equal(refused.error?.code, PAID_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(refused.payment, undefined);
  assert.equal(seller.payment.calls.admit.length, 1);
});
