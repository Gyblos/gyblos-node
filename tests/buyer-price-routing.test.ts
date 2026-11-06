// One buyer, one free and one paid seller, both signing real quotes over loopback: the seller's
// signed price decides the route. A zero buyer budget never reaches the paid port, and a budget
// below every listed price says so instead of reporting that no seller exists.
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { selectionFixture } from './support/buyer-selection';

const RANDOM_DRAWS = [0, 0.5, 0.999];
const ZERO_BUDGET = {
  maxAtomic: '0',
  priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
};

async function market() {
  const paid = await selectionFixture();
  const free = await selectionFixture(true);
  const quotes = new Map<string, number>();
  const runs = [paid, free];
  const config: BuyerSelectionConfig = {
    request: paid.config.request,
    sellers: [...paid.config.sellers, ...free.config.sellers],
  };
  const dependencies = {
    ...paid.dependencies,
    async connect(seller: { nodeId: string }) {
      const run = runs.find((each) => each.catalog.nodeId === seller.nodeId);
      assert.ok(run);
      const { client } = run;
      return {
        getCatalog: client.getCatalog.bind(client),
        getPresence: client.getPresence.bind(client),
        close: client.close.bind(client),
        requestOffer: (...args: Parameters<typeof client.requestOffer>) => {
          quotes.set(seller.nodeId, (quotes.get(seller.nodeId) ?? 0) + 1);
          return client.requestOffer(...args);
        },
      };
    },
  };
  return {
    paid,
    free,
    config,
    dependencies,
    quotes: (run: typeof paid) => quotes.get(run.catalog.nodeId) ?? 0,
    close: () => Promise.all(runs.map((each) => each.wire.close())),
  };
}

// The trusted selection port the router uses, minus local state: excluded sellers are left out.
function route(
  m: Awaited<ReturnType<typeof market>>,
  config: BuyerSelectionConfig,
  random = () => 0,
) {
  const executed: string[] = [];
  return {
    executed,
    run: () =>
      executeBuyerQuote({
        enter: () => () => {},
        unresolved: async () => false,
        async select(excluded, signal) {
          const result = await selectVerifiedBuyerQuote(
            {
              ...config,
              sellers: config.sellers.filter(
                (seller) => !excluded.has(seller.nodeId),
              ),
            },
            { ...m.dependencies, random },
            signal,
          );
          if (!result.ok) throw new Error(result.code);
          return {
            nodeId: result.winner.candidate.nodeId,
            quote: result.winner.quote,
          };
        },
        free: async (winner) => {
          executed.push(`free:${winner.nodeId}`);
          return winner.quote.offer;
        },
        paid: async (winner) => {
          executed.push(`paid:${winner.nodeId}`);
          return winner.quote.offer;
        },
      }),
  };
}

void test("each seller's signed price picks the route for a buyer with a paid budget", async () => {
  const m = await market();
  try {
    for (const [run, kind] of [
      [m.free, OFFER_PRICING_KINDS.FREE],
      [m.paid, OFFER_PRICING_KINDS.PAID],
    ] as const) {
      const routed = route(m, {
        ...m.config,
        pinnedNodeId: run.catalog.nodeId,
      });
      const result = await routed.run();
      assert.equal(result.kind, kind);
      assert.deepEqual(routed.executed, [`${kind}:${run.catalog.nodeId}`]);
      const free = kind === OFFER_PRICING_KINDS.FREE;
      assert.equal(result.result.maxAtomic === '0', free);
      assert.equal(result.result.prices.inputAtomicPerMtok === '0', free);
      assert.equal(result.result.prices.outputAtomicPerMtok === '0', free);
    }
  } finally {
    await m.close();
  }
});

void test('a zero buyer budget is served only by the free seller and never quotes the paid one', async () => {
  const m = await market();
  try {
    const config = {
      ...m.config,
      request: { ...m.config.request, ...ZERO_BUDGET },
    };
    for (const draw of RANDOM_DRAWS) {
      const routed = route(m, config, () => draw);
      assert.equal((await routed.run()).kind, OFFER_PRICING_KINDS.FREE);
      assert.deepEqual(routed.executed, [`free:${m.free.catalog.nodeId}`]);
    }
    assert.equal(m.quotes(m.paid), 0);
    assert.equal(m.quotes(m.free), RANDOM_DRAWS.length);
  } finally {
    await m.close();
  }
});

void test('a budget below every listed price is reported as such, before any quote', async () => {
  const m = await market();
  try {
    const result = await selectVerifiedBuyerQuote(
      {
        request: { ...m.config.request, ...ZERO_BUDGET },
        sellers: m.paid.config.sellers,
      },
      m.dependencies,
    );
    assert.deepEqual(result, {
      ok: false,
      code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET,
    });
    assert.equal(m.quotes(m.paid), 0);
  } finally {
    await m.close();
  }
});

void test('a seller that does not offer the model is still no candidate, whatever its price', async () => {
  const m = await market();
  try {
    const result = await selectVerifiedBuyerQuote(
      {
        request: {
          ...m.config.request,
          ...ZERO_BUDGET,
          selection: { ...m.config.request.selection, modelId: 'absent-model' },
        },
        sellers: m.paid.config.sellers,
      },
      m.dependencies,
    );
    assert.deepEqual(result, {
      ok: false,
      code: SELLER_SELECTION_CODES.NO_CANDIDATES,
    });
  } finally {
    await m.close();
  }
});
