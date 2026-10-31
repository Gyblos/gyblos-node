// The paid buyer's real dependencies over fakes: one paid request at a time, a journal entry not yet
// settled blocks new payments, a free winner is skipped so every request pays, and execution reaches
// only configured sellers with paid quotes. Fake selection, payment and paid client; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Endpoint } from '@number0/iroh';

import {
  FREE_BUYER_CODES,
  PAID_BUYER,
  PAID_BUYER_CODES,
} from '@gyblos/buyer/constants';
import type { PaidWinner } from '@gyblos/buyer/paid-execution';
import { paidBuyerDependencies } from '@gyblos/buyer/paid-selection';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { PROTOCOL_FEE } from '@gyblos/config';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import type {
  PaymentClient,
  PaymentReconciliation,
} from '@gyblos/protocol/payment';
import type { createPaidExecutionClient } from '@gyblos/transport-iroh/paid-client';

import { setup } from './support/buyer-paid';
import { request } from './support/paid-fixture';

const OWNER = '4NxTufBox2MsDggn9yF2vEZ6TE55ZkcgoEY5Kuv1oRTP';

async function harness(channels: PaymentReconciliation[] = []) {
  const buyer = await setup();
  const [paidA, paidB] = buyer.winners;
  const free = (winner: PaidWinner): PaidWinner => ({
    ...winner,
    quote: {
      ...winner.quote,
      offer: { ...winner.quote.offer, maxAtomic: '0' },
    },
  });
  const config: BuyerSelectionConfig = {
    request: {
      selection: paidA!.quote.offer.selection,
      reasoning: paidA!.quote.offer.reasoning,
      lowestReasoning: null,
      network: paidA!.quote.offer.network,
      asset: paidA!.quote.offer.mint,
      maxTokens: 10,
      maxAtomic: paidA!.quote.offer.maxAtomic,
      priceCeilings: paidA!.quote.offer.prices,
      minimumBadge: 'declared-usage',
      retention: ['none'],
    },
    sellers: buyer.winners.map((winner) => ({
      owner: OWNER,
      nodeId: winner.nodeId,
      relayUrl: null,
      directAddresses: [],
    })),
  };
  // Winners in the order selection would return them, whatever is excluded.
  const queue: PaidWinner[] = [];
  const excludedSeen: string[][] = [];
  const executed: { nodeId: string; trust: unknown }[] = [];
  const payment: PaymentClient = {
    ...buyer.dependencies.payment,
    reconcile: async () => channels,
  };
  const client: typeof createPaidExecutionClient = (
    _endpoint,
    _address,
    trust,
  ) => ({
    execute: async () => {
      executed.push({ nodeId: trust.nodeId, trust });
      throw new Error('scripted elsewhere');
    },
    close: () => {},
    settled: async () => {},
  });
  const dependencies = paidBuyerDependencies(
    {
      config,
      stats: { rows: new Map(), save: async () => {} },
      discovery: undefined,
    },
    {
      endpoint: {
        id: () => ({ toString: () => 'buyer' }),
      } as unknown as Endpoint,
      buyer: paidA!.quote.offer.buyer,
      relayOnly: false,
      payment,
      fee: PROTOCOL_FEE,
      meter: buyer.dependencies.meter,
      record: async () => {},
      client,
      choose: async (_prepared, _options, excluded) => {
        excludedSeen.push([...excluded]);
        const next = queue.shift();
        if (!next) throw new Error('no seller');
        return next;
      },
    },
  );
  return {
    dependencies,
    queue,
    excludedSeen,
    executed,
    paidA: paidA!,
    paidB: paidB!,
    free,
  };
}

void test('one paid request at a time', async () => {
  const { dependencies } = await harness();
  const release = dependencies.enter();
  assert.throws(() => dependencies.enter(), {
    code: PAID_BUYER_CODES.BUSY,
  });
  release();
  dependencies.enter()();
});

void test('a journal entry not yet settled blocks new payments', async () => {
  const channel = {
    channelId: 'c'.repeat(32),
    requestDigest: 'd'.repeat(64),
    chargedAtomic: null,
  };
  for (const [channels, blocked] of [
    [[], false],
    [[{ ...channel, state: PAYMENT_CHANNEL_STATES.SETTLED }], false],
    [[{ ...channel, state: PAYMENT_CHANNEL_STATES.OPEN }], true],
  ] as const) {
    const { dependencies } = await harness([...channels]);
    assert.equal(await dependencies.unresolved(), blocked);
  }
});

void test('a free winner is skipped, so a paid buyer always pays a paid seller', async () => {
  const run = await harness();
  run.queue.push(run.free(run.paidA), run.paidB);
  const winner = await run.dependencies.select(
    new Set(),
    new AbortController().signal,
  );
  assert.equal(winner, run.paidB);
  assert.deepEqual(run.excludedSeen, [[], [run.paidA.nodeId]]);
  // Only free winners left: nothing to buy.
  const none = await harness();
  for (let index = 0; index <= PAID_BUYER.freeSkips; index++)
    none.queue.push(none.free(none.paidA));
  await assert.rejects(
    none.dependencies.select(new Set(), new AbortController().signal),
    { code: PAID_BUYER_CODES.UNAVAILABLE },
  );
});

void test('execution reaches only a configured seller with a paid quote', async () => {
  const run = await harness();
  const paid = await request();
  const signal = new AbortController().signal;
  const execute = (winner: PaidWinner) =>
    run.dependencies.execute(winner, paid, signal, async () => {});
  for (const winner of [
    { ...run.paidA, nodeId: 'e'.repeat(64) },
    run.free(run.paidA),
  ])
    await assert.rejects(execute(winner), {
      code: FREE_BUYER_CODES.UNAVAILABLE,
    });
  await assert.rejects(execute(run.paidA), /scripted elsewhere/);
  assert.deepEqual(
    run.executed.map((each) => each.nodeId),
    [run.paidA.nodeId],
  );
});
