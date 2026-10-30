// The daemon's paid selling wiring: the payment server's description must charge the network's fee
// and pay out to an account other than the fee payer; paid offers are routed to one paid service per
// offer; pending claims are retried; closing stops claims, retries and the payment server in order.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTOCOL_FEE } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import type { LiveSellerOffer } from '@gyblos/node/seller-offer-set';
import { openSellerPaid, startSellerPaid } from '@gyblos/node/seller-paid';
import {
  CONTROL_METERING_MODES,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { PAID_PRICES, paidSellerFixture } from './support/paid-seller';

async function wired(waitMs = 20) {
  const seller = await paidSellerFixture();
  const own = await seller.payment.server.describe();
  seller.payment.control.description = {
    ...own,
    protocolFeeBps: PROTOCOL_FEE.bps,
    treasury: PROTOCOL_FEE.treasury,
  };
  const { options } = seller;
  const live: LiveSellerOffer = {
    index: 0,
    selection: options.selection,
    offer: {
      kind: OFFER_PRICING_KINDS.PAID,
      modelId: options.selection.modelId,
      reasoning: [REASONING_LEVELS.OFF],
      prices: PAID_PRICES,
    },
    model: options.model,
    capabilities: options.capabilities,
    meteringMode: CONTROL_METERING_MODES.RECOUNTED,
    readiness: options.readiness,
    engine: options.engine,
    meter: options.meter,
    observation: { start: () => {}, stop: async () => {} },
  };
  const events: string[] = [];
  const paid = await startSellerPaid(
    {
      server: seller.payment.server,
      close: async () => {
        events.push('payments closed');
      },
    },
    {
      owner: options.owner,
      nodeId: options.nodeId,
      startedAt: options.now() - 1,
      now: options.now,
      offers: () => [live],
      settlement: { waitMs, retryDelaysMs: [5] },
    },
  );
  return { seller, paid, events };
}

void test('a description off the network fee, network or payout refuses paid selling', async () => {
  const { seller } = await wired();
  const valid = await seller.payment.server.describe();
  for (const description of [
    { ...valid, protocolFeeBps: PROTOCOL_FEE.bps + 1 },
    { ...valid, treasury: 'someone-else' },
    { ...valid, network: 'solana:another' },
    { ...valid, payTo: valid.feePayer },
  ]) {
    seller.payment.control.description = description;
    await assert.rejects(
      startSellerPaid(
        { server: seller.payment.server, close: async () => {} },
        {
          owner: seller.options.owner,
          nodeId: seller.options.nodeId,
          startedAt: 0,
          offers: () => [],
        },
      ),
      (error) =>
        error instanceof NodeError &&
        error.code === NODE_ERROR_CODES.SELLER_PAYMENT_DESCRIPTION_INVALID,
    );
  }
});

void test('paid offers are served and settled; a pending claim is retried in the background', async () => {
  const { seller, paid } = await wired();
  const signal = new AbortController().signal;
  const quoted = await seller.request(1);
  const peer = quoted.quote.offer.buyerNodeId;
  const served = await paid.service.stream(
    quoted,
    peer,
    signal,
    async () => {},
  );
  assert.equal(served.payment?.settlement?.chargedAtomic, '10');
  // A slow claim is reported pending, then the retry settles the same charge.
  seller.payment.control.settle = { kind: 'delay', ms: 40 };
  const second = await seller.request(2);
  const pending = await paid.service.stream(
    second,
    peer,
    signal,
    async () => {},
  );
  assert.equal(pending.payment?.pending?.chargedAtomic, '10');
  while (paid.health().queued > 0)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(paid.health().settled, 1);
  const charges = seller.payment.calls.settle
    .filter((call) => call.admission.channelId === second.payment.channelId)
    .map((call) => call.chargedAtomic);
  assert.ok(charges.length >= 2);
  assert.ok(charges.every((charge) => charge === '10'));
  await paid.close();
});

void test('closing stops waiting on claims before closing the payment server', async () => {
  // A long wait: only stopping the daemon can end it promptly.
  const { seller, paid, events } = await wired(60_000);
  seller.payment.control.settle = { kind: 'hang' };
  const quoted = await seller.request(1);
  const signal = new AbortController().signal;
  const running = paid.service.stream(
    quoted,
    quoted.quote.offer.buyerNodeId,
    signal,
    async () => {},
  );
  // Close only once the claim is in flight.
  while (seller.payment.calls.settle.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await paid.close();
  const terminal = await running;
  assert.ok(Date.now() - started < 5_000);
  assert.ok(terminal.payment?.pending);
  assert.deepEqual(events, ['payments closed']);
});

void test('opening paid selling closes the payment server when its description is refused', async () => {
  const { seller } = await wired();
  const own = await seller.payment.server.describe();
  seller.payment.control.description = { ...own, payTo: own.feePayer };
  let closed = 0;
  await assert.rejects(
    openSellerPaid(
      async () => ({
        server: seller.payment.server,
        close: async () => {
          closed++;
        },
      }),
      {
        owner: seller.options.owner,
        nodeId: seller.options.nodeId,
        startedAt: 0,
        offers: () => [],
      },
    ),
    NodeError,
  );
  assert.equal(closed, 1);
});
