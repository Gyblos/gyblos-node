// Exercises HTTP discovery → identity/replay admission → signed Iroh-loopback quotes and v1 proxy guard.
// Synthetic public records and unfunded signers only; payment legs are never executed.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { selectBuyerQuote } from '@gyblos/buyer/selection';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { createProxySelection } from '@gyblos/buyer/selection-proxy';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import {
  discoveryHome,
  discoveryResponse,
  discoveryRun,
} from './support/buyer-discovery';

void test('loopback HTTP discovery selects only independently trusted identities and refreshes signed Iroh quotes', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  const unknown = await discoveryRun();
  const server = createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        sellers: [run.entry, unknown.entry],
        next: null,
        generatedAt: run.context.now(),
      }),
    ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const config = await discoverBuyerSellers(
      {
        ...run.config,
        discovery: {
          ...run.config.discovery,
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
      },
      home.state,
      { fetch: globalThis.fetch, now: run.context.now },
    );
    let connects = 0;
    const result = await selectBuyerQuote(config, {
      ...run.dependencies,
      connect: async (seller) => {
        connects++;
        assert.equal(seller.nodeId, run.catalog.nodeId);
        return run.client;
      },
      observeVerified: (seller) => home.state.observe(seller),
    });
    assert.equal(result.ok, true);
    assert.equal(connects, 1);
    assert.equal(run.wire.queries, 5); // Two signed snapshots for the fake index, then fresh catalog/presence/quote.
    assert.equal(unknown.wire.queries, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await run.wire.close();
    await unknown.wire.close();
    await home.close();
  }
});
void test('same NodeId with a different declared owner is dropped before any control connection', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const owner = '11111111111111111111111111111111';
    const catalog = await signPublicV2(
      { ...run.catalog, owner },
      run.nodeSigner,
    );
    const { catalogDigestV2 } = await import('@gyblos/protocol/public-v2');
    const presence = await signPublicV2(
      {
        ...run.known.presence!,
        owner,
        catalogDigest: await catalogDigestV2(catalog.record),
      },
      run.nodeSigner,
    );
    const result = await discoverBuyerSellers(run.config, home.state, {
      fetch: async () => discoveryResponse([{ catalog, presence }]),
      now: run.context.now,
    });
    assert.equal(result.sellers.length, 0);
    assert.equal(
      home.state.eligible(run.config.sellers, run.context.now()).length,
      0,
    );
    assert.equal(run.wire.queries, 2);
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('equal index presence and omitted entries retain live held candidate IDs after restart', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const fetch = async () => discoveryResponse([run.entry]);
    assert.equal(
      (
        await discoverBuyerSellers(run.config, home.state, {
          fetch,
          now: run.context.now,
        })
      ).sellers.length,
      1,
    );
    const state = await buyerDiscoveryState(home.environment);
    assert.equal(
      (
        await discoverBuyerSellers(run.config, state, {
          fetch,
          now: run.context.now,
        })
      ).sellers.length,
      1,
    );
    assert.equal(
      (
        await discoverBuyerSellers(run.config, state, {
          fetch: async () => discoveryResponse([]),
          now: run.context.now,
        })
      ).sellers.length,
      1,
    );
    assert.equal(
      (
        await discoverBuyerSellers(run.config, state, {
          fetch: async () => discoveryResponse([]),
          now: () => run.known.presence!.expiresAt,
        })
      ).sellers.length,
      0,
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('cross-page same-sequence catalog forks are persisted as blocked, never silently chosen', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const altered = {
      ...run.catalog,
      dataPolicy: { ...run.catalog.dataPolicy },
      models: run.catalog.models.map((model) => ({
        ...model,
        contextTokens: model.contextTokens + 1,
      })),
    };
    const catalog = await signPublicV2(altered, run.nodeSigner);
    const { catalogDigestV2 } = await import('@gyblos/protocol/public-v2');
    const presence = await signPublicV2(
      { ...run.known.presence!, catalogDigest: await catalogDigestV2(altered) },
      run.nodeSigner,
    );
    let page = 0;
    const result = await discoverBuyerSellers(run.config, home.state, {
      fetch: async () =>
        ++page === 1
          ? discoveryResponse([run.entry], 'second')
          : discoveryResponse([{ catalog, presence }]),
      now: run.context.now,
    });
    assert.equal(result.sellers.length, 0);
    assert.equal(
      (await buyerDiscoveryState(home.environment)).eligible(
        run.config.sellers,
        run.context.now(),
      ).length,
      0,
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('pagination loops and page caps fail closed without control queries', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    let calls = 0;
    await assert.rejects(
      discoverBuyerSellers(run.config, home.state, {
        fetch: async () => {
          calls++;
          return discoveryResponse([run.entry], 'repeat');
        },
        now: run.context.now,
      }),
      { code: BUYER_SELECTION_CODES.DISCOVERY_LIMIT },
    );
    assert.equal(calls, 2);
    await assert.rejects(
      discoverBuyerSellers(
        { ...run.config, discovery: { ...run.config.discovery, maxPages: 1 } },
        home.state,
        {
          fetch: async () => discoveryResponse([], 'next'),
          now: run.context.now,
        },
      ),
      { code: BUYER_SELECTION_CODES.DISCOVERY_LIMIT },
    );
    assert.equal(run.wire.queries, 2);
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('discovery runs only before authorization; a non-trusted winner cannot acquire a v1 decision', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    let fetches = 0;
    const route = async (signal: AbortSignal) => {
      const config = await discoverBuyerSellers(run.config, home.state, {
        fetch: async () => {
          fetches++;
          return discoveryResponse([run.entry]);
        },
        now: run.context.now,
        signal,
      });
      return selectBuyerQuote(
        config,
        {
          ...run.dependencies,
          observeVerified: (seller) => home.state.observe(seller),
        },
        signal,
      );
    };
    const guard = createProxySelection(route, 100, run.context.now);
    const body = Buffer.from(
      JSON.stringify({ requestId: 'synthetic', maxTokens: 100 }),
    );
    assert.deepEqual(
      await guard.admit(body, false, new AbortController().signal),
      { ok: true },
    );
    assert.deepEqual(
      await guard.admit(body, true, new AbortController().signal),
      { ok: true },
    );
    assert.equal(
      (await guard.admit(body, true, new AbortController().signal)).ok,
      false,
    );
    assert.equal(fetches, 1);
    const config = await discoverBuyerSellers(run.config, home.state, {
      fetch: async () => discoveryResponse([run.entry]),
      now: run.context.now,
    });
    const result = await selectBuyerQuote(config, {
      ...run.dependencies,
      trusted: { owner: run.catalog.owner, nodeId: '0'.repeat(64) },
      observeVerified: (seller) => home.state.observe(seller),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, BUYER_SELECTION_CODES.QUOTE_ONLY);
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('discovery config is opt-in, bounded and preserves static-only compatibility', async () => {
  const run = await discoveryRun();
  try {
    assert.equal(parseBuyerSelectionConfig(run.config).discovery?.maxPages, 3);
    assert.equal(
      parseBuyerSelectionConfig(run.config).sellers[0]!.owner,
      run.catalog.owner,
    );
    const { discovery: _discovery, ...staticOnly } = run.config;
    assert.equal(parseBuyerSelectionConfig(staticOnly).discovery, undefined);
    for (const discovery of [
      { baseUrl: 'http://remote.test' },
      { maxPages: 100 },
      { unknown: true },
    ])
      assert.throws(
        () => parseBuyerSelectionConfig({ ...run.config, discovery }),
        { code: BUYER_SELECTION_CODES.INVALID },
      );
  } finally {
    await run.wire.close();
  }
});
void test('a deadline or cancellation discards a late index response before selection', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    let release!: (response: Response) => void;
    await assert.rejects(
      discoverBuyerSellers(run.config, home.state, {
        fetch: () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
        now: run.context.now,
        timeoutMs: 20,
      }),
    );
    release(discoveryResponse([run.entry]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      home.state.eligible(run.config.sellers, run.context.now()).length,
      0,
    );
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await assert.rejects(
      discoverBuyerSellers(run.config, home.state, {
        fetch: async () => {
          called = true;
          return discoveryResponse([run.entry]);
        },
        now: run.context.now,
        signal: controller.signal,
      }),
    );
    assert.equal(called, false);
  } finally {
    await run.wire.close();
    await home.close();
  }
});

void test('fresh Iroh records older than the accepted HTTP snapshot cannot reach a quote', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const catalog = await signPublicV2(
      { ...run.catalog, sequence: 10 },
      run.nodeSigner,
    );
    const { catalogDigestV2 } = await import('@gyblos/protocol/public-v2');
    const presence = await signPublicV2(
      {
        ...run.known.presence!,
        sequence: 11,
        catalogDigest: await catalogDigestV2(catalog.record),
      },
      run.nodeSigner,
    );
    const config = await discoverBuyerSellers(run.config, home.state, {
      fetch: async () => discoveryResponse([{ catalog, presence }]),
      now: run.context.now,
    });
    const result = await selectBuyerQuote(config, {
      ...run.dependencies,
      observeVerified: (seller) => home.state.observe(seller),
    });
    assert.equal(result.ok, false);
    assert.equal(run.wire.queries, 4); // Initial snapshots plus refresh; no quote.
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('failed replay persistence prevents even a signed fresh candidate from reaching quote selection', async () => {
  const run = await discoveryRun();
  try {
    const result = selectBuyerQuote(run.config, {
      ...run.dependencies,
      observeVerified: async () => {
        const { BuyerSelectionError } =
          await import('@gyblos/buyer/selection-config');
        throw new BuyerSelectionError(BUYER_SELECTION_CODES.DISCOVERY_STATE);
      },
    });
    await assert.rejects(result, {
      code: BUYER_SELECTION_CODES.DISCOVERY_STATE,
    });
    assert.equal(run.wire.queries, 4);
  } finally {
    await run.wire.close();
  }
});
