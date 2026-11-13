// A busy seller's price reference bounds fallback only for the exact model listing a request prices.
// Occupancy stays per seller: switching models never runs two requests on one seller at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { referencePrices, routeScope } from '@gyblos/buyer/session-routing';
import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import type { SellerRequest } from '@gyblos/core/seller-selection';
import {
  createBuyerRouter,
  UnsentSellerBusyError,
  type BuyerRoutePorts,
  type BuyerRouteScope,
} from '@gyblos/node/buyer-routing';
import type {
  PublicModelV2,
  TokenPricesV2,
} from '@gyblos/protocol/control-types';

import { batchDeferred } from './support/batch-deferred';
import { multisellerSession } from './support/multiseller-session';

const Q8 = { key: 'qwen3-0.6b/Q8_0' };
const Q4 = { key: 'qwen3-0.6b/Q4_K_M' };
const prices = (input: string, output: string): TokenPricesV2 => ({
  inputAtomicPerMtok: input,
  outputAtomicPerMtok: output,
});
const FREE = { prices: prices('0', '0'), maxAtomic: '0' };

async function rig(
  t: test.TestContext,
  bPrices = prices('5000000', '5000000'),
  pinned = true,
) {
  const source = await multisellerSession();
  const offers = source.offers;
  const aPaid = await offers[0]!.quote(1, {
    prices: prices('8000000', '8000000'),
  });
  const aFree = await offers[0]!.quote(2, FREE);
  const bPaid = await offers[1]!.quote(3, { prices: bPrices });
  const bFree = await offers[1]!.quote(4, FREE);
  const a = aPaid.offer.nodeId;
  const scopes: (BuyerRouteScope | undefined)[] = [];
  const router = createBuyerRouter({
    now: source.a.now,
    policy: parseBuyerRoutingPolicy({ allowPinnedFallback: true }),
    pinnedNodeId: pinned ? a : undefined,
    priceCeilings: prices('9000000', '9000000'),
    unresolved: async () => false,
    reference: async (_nodeId, _signal, scope) => {
      scopes.push(scope);
      return undefined;
    },
  });
  const entered = batchDeferred<void>();
  const finish = batchDeferred<void>();
  const running = new Map<string, number>();
  let most = 0;
  const runs: string[] = [];
  const ports = (
    onA: typeof aPaid,
    onB: typeof bPaid,
  ): BuyerRoutePorts<string> => {
    const execute = async (winner: { nodeId: string; quote: typeof aPaid }) => {
      const count = (running.get(winner.nodeId) ?? 0) + 1;
      running.set(winner.nodeId, count);
      most = Math.max(most, count);
      runs.push(
        `${winner.nodeId === a ? 'A' : 'B'}:${winner.quote.offer.prices.inputAtomicPerMtok}`,
      );
      try {
        if (winner.quote === aPaid) {
          entered.resolve();
          await finish.promise;
        }
        return winner.nodeId === a ? 'A' : 'B';
      } finally {
        running.set(winner.nodeId, count - 1);
      }
    };
    return {
      select: async (excluded) => {
        const quote = excluded.has(a) ? onB : onA;
        return { nodeId: quote.offer.nodeId, quote };
      },
      free: execute,
      paid: execute,
    };
  };
  t.after(async () => {
    finish.resolve();
    await router.close();
    await source.close();
  });
  return {
    router,
    ports,
    aPaid,
    aFree,
    bPaid,
    bFree,
    entered,
    finish,
    scopes,
    runs,
    most: () => most,
  };
}

void test('a free Q4 request never borrows the price of a paid Q8 request running on the same seller', async (t) => {
  const host = await rig(t);
  const q8 = host.router.execute(
    host.ports(host.aPaid, host.bPaid),
    AbortSignal.timeout(3000),
    Q8,
  );
  await host.entered.promise;
  await assert.rejects(
    host.router.execute(
      host.ports(host.aFree, host.bPaid),
      AbortSignal.timeout(3000),
      Q4,
    ),
    { code: BUYER_ROUTING_CODES.BUSY },
  );
  host.finish.resolve();
  assert.equal((await q8).result, 'A');
  assert.deepEqual(host.runs, ['A:8000000']);
});

for (const [name, bPrices, allowed] of [
  ['both prices lower', prices('5000000', '5000000'), true],
  ['input lower but output higher', prices('5000000', '8500000'), false],
  ['output lower but input higher', prices('8500000', '5000000'), false],
] as const)
  void test(`a matching listing reference allows fallback only within each price: ${name}`, async (t) => {
    const host = await rig(t, bPrices);
    const first = host.router.execute(
      host.ports(host.aPaid, host.bPaid),
      AbortSignal.timeout(3000),
      Q8,
    );
    await host.entered.promise;
    const second = host.router.execute(
      host.ports(host.aPaid, host.bPaid),
      AbortSignal.timeout(3000),
      Q8,
    );
    if (allowed) assert.equal((await second).result, 'B');
    else await assert.rejects(second, { code: BUYER_ROUTING_CODES.BUSY });
    host.finish.resolve();
    await first;
    assert.equal(
      host.runs.filter((run) => run.startsWith('B')).length,
      allowed ? 1 : 0,
    );
  });

void test('switching models never runs two requests on one seller at once', async (t) => {
  const host = await rig(t, undefined, false);
  const q8 = host.router.execute(
    host.ports(host.aPaid, host.bPaid),
    AbortSignal.timeout(3000),
    Q8,
  );
  await host.entered.promise;
  // Unpinned, priced by its own quote: A answers Q4 for free, but A is busy, so only a free B may answer.
  const q4 = await host.router.execute(
    host.ports(host.aFree, host.bFree),
    AbortSignal.timeout(3000),
    Q4,
  );
  assert.equal(q4.result, 'B');
  host.finish.resolve();
  await q8;
  assert.equal(host.most(), 1);
  assert.deepEqual(host.runs, ['A:8000000', 'B:0']);
});

void test('a remote busy refresh asks for the requesting listing', async (t) => {
  const host = await rig(t);
  const busyA: BuyerRoutePorts<string> = {
    ...host.ports(host.aFree, host.bPaid),
    select: async (excluded) => {
      if (!excluded.has(host.aFree.offer.nodeId))
        throw new UnsentSellerBusyError(host.aFree.offer.nodeId);
      return { nodeId: host.bPaid.offer.nodeId, quote: host.bPaid };
    },
  };
  await assert.rejects(
    host.router.execute(busyA, AbortSignal.timeout(3000), Q4),
    {
      code: BUYER_ROUTING_CODES.BUSY,
    },
  );
  assert.deepEqual(host.scopes, [Q4]);
});

const listing = (quantization: string, input: string, output: string) =>
  ({
    modelId: 'qwen3-0.6b',
    variant: null,
    quantization,
    reasoning: ['off'],
    pricing: {
      network: 'devnet',
      asset: 'mint',
      inputAtomicPerMtok: input,
      outputAtomicPerMtok: output,
    },
  }) as unknown as PublicModelV2;
const request = (quantization: string) =>
  ({
    selection: { modelId: 'qwen3-0.6b', variant: null, quantization },
    reasoning: 'off',
    network: 'devnet',
    asset: 'mint',
  }) as unknown as SellerRequest;

void test('a refreshed catalog reference prices only the requested listing', () => {
  const catalog = {
    expiresAt: 2000,
    models: [
      listing('Q8_0', '8000000', '8000000'),
      listing('Q4_K_M', '0', '0'),
    ],
  };
  assert.deepEqual(
    referencePrices(catalog, request('Q4_K_M'), 1000),
    prices('0', '0'),
  );
  assert.deepEqual(
    referencePrices(catalog, request('Q8_0'), 1000),
    prices('8000000', '8000000'),
  );
  assert.equal(referencePrices(catalog, request('Q5_K_M'), 1000), undefined);
  assert.equal(referencePrices(catalog, request('Q4_K_M'), 2000), undefined);
  assert.notEqual(
    routeScope(request('Q4_K_M')).key,
    routeScope(request('Q8_0')).key,
  );
  assert.equal(
    routeScope({ ...request('Q4_K_M'), network: 'other' } as SellerRequest)
      .key === routeScope(request('Q4_K_M')).key,
    false,
  );
});
