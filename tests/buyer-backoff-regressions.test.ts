// Backoff exceptions follow usable alternatives and committed selections, not configured row counts.
// Signed in-memory control sellers and unfunded temporary homes avoid payments and network calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Endpoint } from '@number0/iroh';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { createBuyerControlClient } from '@gyblos/buyer/control';
import { selectWinner } from '@gyblos/buyer/free-selection';
import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import { createSellerBackoff } from '@gyblos/buyer/selection-backoff';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';
import { CONTROL_METHODS } from '@gyblos/protocol/constants';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';

async function isolatedHome(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-backoff-regression-'));
  const originalDirectory = process.cwd();
  const originalHome = process.env.GYBLOS_HOME;
  const originalLabHome = process.env.GYBLOS_LAB_HOME;
  process.chdir(directory);
  process.env.GYBLOS_HOME = join(directory, 'product');
  process.env.GYBLOS_LAB_HOME = join(directory, 'lab');
  context.after(async () => {
    process.chdir(originalDirectory);
    if (originalHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = originalHome;
    if (originalLabHome === undefined) delete process.env.GYBLOS_LAB_HOME;
    else process.env.GYBLOS_LAB_HOME = originalLabHome;
    await rm(directory, { recursive: true, force: true });
  });
}

function configuration(
  source: Awaited<ReturnType<typeof controlFixture>>,
  other: Awaited<ReturnType<typeof controlFixture>>,
): BuyerSelectionConfig {
  const {
    buyer: _buyer,
    buyerNodeId: _node,
    catalogDigest: _digest,
    ...request
  } = source.request.params;
  return {
    request: {
      ...request,
      lowestReasoning: null,
      minimumBadge: SELLER_BADGES.DECLARED_USAGE,
      retention: [source.catalog.dataPolicy.retention],
    },
    sellers: [source, other].map(({ catalog }) => ({
      owner: catalog.owner,
      nodeId: catalog.nodeId,
      relayUrl: null,
      directAddresses: [],
    })),
    quoteWindowMs: 2000,
  };
}

function memorySeller(source: Awaited<ReturnType<typeof controlFixture>>) {
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  let quotes = 0;
  return {
    quotes: () => quotes,
    client: () =>
      createBuyerControlClient(
        {
          localNodeId: source.request.params.buyerNodeId,
          remoteNodeId: source.catalog.nodeId,
          exchange: (value, signal) => {
            if (
              typeof value === 'object' &&
              value !== null &&
              'method' in value &&
              value.method === CONTROL_METHODS.OFFER
            )
              quotes++;
            return service.respond(
              value,
              source.request.params.buyerNodeId,
              signal ?? new AbortController().signal,
            );
          },
          close: async () => {},
        },
        { ...source.trust(), now: source.context.now },
      ),
  };
}

void test('a configured seller for another model is not an alternative that extends the only usable seller cooldown', async (context) => {
  await isolatedHome(context);
  const source = await controlFixture(true);
  const other = await controlFixture(true);
  other.context.catalog = await signPublicV2(
    {
      ...other.catalog,
      models: other.catalog.models.map((model) => ({
        ...model,
        modelId: 'another-model',
      })),
    },
    other.nodeSigner,
  );
  const config = configuration(source, other);
  const main = memorySeller(source);
  const alternative = memorySeller(other);
  let alive = false;
  let dials = 0;
  let now = source.context.now();
  const setClock = () => {
    for (const seller of [source, other]) {
      seller.setNow(now);
      seller.setReadiness({ observedAt: now, validUntil: now + 20_000 });
    }
  };
  const dependencies = {
    buyer: source.request.params.buyer,
    stats: new Map<string, LocalSellerStats>(),
    backoff: createSellerBackoff(),
    now: () => now,
    random: () => 0,
    connect: async (seller: { nodeId: string }) => {
      if (seller.nodeId !== source.catalog.nodeId) return alternative.client();
      dials++;
      if (!alive) throw new Error('Synthetic unreachable seller');
      return main.client();
    },
  };
  setClock();
  assert.equal(
    (await selectVerifiedBuyerQuote(config, dependencies)).ok,
    false,
  );
  const firstCooldown =
    dependencies.stats.get(source.catalog.nodeId)!.cooldownUntil! - now;
  now += BUYER_SELECTION.cooldownMs + 1;
  setClock();
  assert.equal(
    (await selectVerifiedBuyerQuote(config, dependencies)).ok,
    false,
  );
  const secondCooldown =
    dependencies.stats.get(source.catalog.nodeId)!.cooldownUntil! - now;
  alive = true;
  now += BUYER_SELECTION.cooldownMs + 1;
  setClock();
  const recovered = await selectVerifiedBuyerQuote(config, dependencies);
  assert.deepEqual(
    {
      firstCooldown,
      secondCooldown,
      recovered: recovered.ok,
      dials,
      alternativeQuotes: alternative.quotes(),
    },
    {
      firstCooldown: BUYER_SELECTION.cooldownMs,
      secondCooldown: BUYER_SELECTION.cooldownMs,
      recovered: true,
      dials: 3,
      alternativeQuotes: 0,
    },
  );
});
