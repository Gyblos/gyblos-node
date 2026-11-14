// Keeps remembered selection bounded and current with already accepted discovery records.
// Uses signed in-memory sellers and isolated replay metadata; never opens a socket or payment path.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import {
  selectVerifiedBuyerQuote,
  type BuyerControlClient,
} from '@gyblos/buyer/selection';
import { createSnapshotCache } from '@gyblos/buyer/selection-cache';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { homeLayout } from '@gyblos/config/home';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';
import { CONTROL_METHODS, CONTROL_VERSION } from '@gyblos/protocol/constants';
import type { PublicCatalogV2 } from '@gyblos/protocol/control-types';
import { signPublicV2 } from '@gyblos/protocol/public-v2';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';

import { controlFixture } from './support/control-fixture';

async function isolatedHome(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-cache-regression-'));
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
  return { GYBLOS_HOME: process.env.GYBLOS_HOME };
}

async function signedSellers(count: number) {
  const sources = await Promise.all(
    Array.from({ length: count }, () => controlFixture(true)),
  );
  const source = sources[0]!;
  const services = sources.map((entry) =>
    createSellerControlService({
      context: entry.context,
      ownerSigner: entry.ownerSigner,
      nodeSigner: entry.nodeSigner,
    }),
  );
  const sellers = sources.map(({ catalog }) => ({
    owner: catalog.owner,
    nodeId: catalog.nodeId,
    relayUrl: null,
    directAddresses: [],
  }));
  const {
    buyer,
    buyerNodeId,
    catalogDigest: _digest,
    ...request
  } = source.request.params;
  const config: BuyerSelectionConfig = {
    request: {
      ...request,
      lowestReasoning: null,
      minimumBadge: SELLER_BADGES.DECLARED_USAGE,
      retention: [source.catalog.dataPolicy.retention],
    },
    sellers,
    quoteWindowMs: 1000,
  };
  let queries = 0;
  const client = (index: number, closed: () => void = () => {}) =>
    createBuyerControlClient(
      {
        localNodeId: buyerNodeId,
        remoteNodeId: sellers[index]!.nodeId,
        exchange: (value, signal) => {
          queries++;
          return services[index]!.respond(
            value,
            buyerNodeId,
            signal ?? new AbortController().signal,
          );
        },
        close: async () => closed(),
      },
      { ...sources[index]!.trust(), now: sources[index]!.context.now },
    );
  return {
    sources,
    services,
    config,
    client,
    queries: () => queries,
    dependencies: {
      buyer,
      stats: new Map<string, LocalSellerStats>(),
      now: source.context.now,
      random: () => 0,
      snapshots: createSnapshotCache(),
    },
  };
}

void test('a newer catalog accepted from discovery supersedes an older remembered snapshot before filtering', async (context) => {
  const environment = await isolatedHome(context);
  await mkdir(homeLayout(environment).roles.buyer, {
    recursive: true,
    mode: 0o700,
  });
  const state = await buyerDiscoveryState(environment);
  const host = await signedSellers(1);
  const source = host.sources[0]!;
  const config = {
    ...host.config,
    discovery: { baseUrl: 'https://index.test/api/v1/discovery', maxPages: 1 },
  };
  const dependencies = {
    ...host.dependencies,
    observeVerified: state.observe,
    connect: async () => host.client(0),
  };
  const discover = async (
    policy: BuyerSelectionConfig & {
      discovery: NonNullable<BuyerSelectionConfig['discovery']>;
    },
  ) => {
    const response = await host.services[0]!.respond(
      {
        version: CONTROL_VERSION,
        requestId: '9'.repeat(32),
        method: CONTROL_METHODS.PRESENCE,
        params: {},
      },
      source.request.params.buyerNodeId,
      new AbortController().signal,
    );
    const result = response.result;
    assert.ok(result);
    assert.equal(result.method, CONTROL_METHODS.PRESENCE);
    if (result.method !== CONTROL_METHODS.PRESENCE) assert.fail();
    const entry = {
      catalog: source.context.catalog,
      presence: result.presence,
    };
    return discoverBuyerSellers(policy, state, {
      now: source.context.now,
      fetch: async () =>
        new Response(
          JSON.stringify({
            sellers: [entry],
            next: null,
            generatedAt: source.context.now(),
          }),
        ),
    });
  };
  assert.equal(
    (await selectVerifiedBuyerQuote(await discover(config), dependencies)).ok,
    true,
  );
  const selection = { ...config.request.selection, modelId: 'fresh-model' };
  const catalog: PublicCatalogV2 = {
    ...source.catalog,
    sequence: 10,
    models: [
      ...source.catalog.models,
      { ...source.catalog.models[0]!, modelId: selection.modelId },
    ],
  };
  source.context.catalog = await signPublicV2(catalog, source.nodeSigner);
  source.context.models = [
    ...source.context.models,
    { ...source.context.models[0]!, selection },
  ];
  const latest = await discover({
    ...config,
    request: { ...config.request, selection },
  });
  assert.equal(latest.sellers.length, 1);
  const before = host.queries();
  const cached = await selectVerifiedBuyerQuote(latest, dependencies);
  const cachedQueries = host.queries() - before;
  const fresh = await selectVerifiedBuyerQuote(latest, {
    ...dependencies,
    snapshots: undefined,
    stats: new Map<string, LocalSellerStats>(),
  });
  assert.equal(
    fresh.ok,
    true,
    'the signed seller serves the newly listed model',
  );
  assert.equal(
    cached.ok,
    true,
    `latest catalog was ignored; queries=${cachedQueries}`,
  );
});
