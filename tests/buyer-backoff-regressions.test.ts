// Backoff exceptions follow usable alternatives and committed selections, not configured row counts.
// Signed in-memory control sellers and unfunded temporary homes avoid payments and network calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { createBuyerControlClient } from '@gyblos/buyer/control';
import { selectWinner } from '@gyblos/buyer/free-selection';
import {
  selectVerifiedBuyerQuote,
  type VerifiedSelectionDependencies,
} from '@gyblos/buyer/selection';
import { createSellerBackoff } from '@gyblos/buyer/selection-backoff';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';
import { CONTROL_LIMITS, CONTROL_METHODS } from '@gyblos/protocol/constants';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import { signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';

type SellerFailure = Parameters<
  NonNullable<VerifiedSelectionDependencies['onSellerFailure']>
>[0];

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

void test('a failed snapshot keeps progressive cooldowns when another seller supplies a valid quote', async (context) => {
  await isolatedHome(context);
  const source = await controlFixture(true);
  const other = await controlFixture(true);
  const config = configuration(source, other);
  const alternative = memorySeller(other);
  const failures: SellerFailure[] = [];
  let now = source.context.now();
  const dependencies = {
    buyer: source.request.params.buyer,
    stats: new Map<string, LocalSellerStats>(),
    backoff: createSellerBackoff(),
    now: () => now,
    random: () => 0,
    onSellerFailure: (failure: SellerFailure) => failures.push(failure),
    connect: async (seller: { nodeId: string }) => {
      if (seller.nodeId === source.catalog.nodeId)
        throw new Error('Synthetic unreachable seller');
      return alternative.client();
    },
  };
  for (const duration of [30_000, 60_000, 120_000]) {
    other.setNow(now);
    other.setReadiness({ observedAt: now, validUntil: now + 20_000 });
    const result = await selectVerifiedBuyerQuote(config, dependencies);
    assert.equal(result.ok, true);
    const until = dependencies.stats.get(source.catalog.nodeId)!.cooldownUntil!;
    assert.equal(until - now, duration);
    assert.equal(failures.at(-1)?.retryAt, until);
    now = until + 1;
  }
});

// A minimal native-port double exercises selectWinner's actual control framing without binding sockets.
function memoryEndpoint(source: Awaited<ReturnType<typeof controlFixture>>) {
  source.context.endpoint = { relayUrl: null, directAddresses: [] };
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  return {
    id: () => ({ toString: () => source.request.params.buyerNodeId }),
    connect: async (remote: EndpointAddr) => {
      if (remote.id().toString() !== source.catalog.nodeId)
        throw new Error('Synthetic unreachable seller');
      return {
        remoteId: () => remote.id(),
        closeReason: () => null,
        close: () => {},
        openBi: async () => {
          let response: Uint8Array = new Uint8Array();
          let offset = 0;
          return {
            send: {
              writeAll: async (bytes: number[]) => {
                const reader = new ControlFrameReader(
                  CONTROL_LIMITS.requestBytes,
                );
                reader.push(Uint8Array.from(bytes));
                response = encodeControlFrame(
                  await service.respond(
                    reader.finish(),
                    source.request.params.buyerNodeId,
                    new AbortController().signal,
                  ),
                  CONTROL_LIMITS.responseBytes,
                );
              },
              finish: async () => {},
            },
            recv: {
              readExact: async (size: number) => {
                const bytes = response.slice(offset, offset + size);
                offset += size;
                return [...bytes];
              },
              read: async () => [],
            },
          };
        },
      } as unknown as Connection;
    },
  } as unknown as Endpoint;
}

void test('a cancelled selection discards earlier backoff mutations along with its quote statistics', async (context) => {
  await isolatedHome(context);
  const source = await controlFixture(true);
  const other = await controlFixture(true);
  const config = configuration(source, other);
  const prepared = {
    config,
    discovery: undefined,
    stats: {
      rows: new Map<string, LocalSellerStats>(),
      save: async () => {},
    },
  };
  const caller = new AbortController();
  let abortOnFailure = true;
  const backoff = createSellerBackoff();
  backoff.failed(source.catalog.nodeId);
  backoff.failed(source.catalog.nodeId);
  const options = {
    endpoint: memoryEndpoint(source),
    buyer: source.request.params.buyer,
    relayOnly: false,
    now: source.context.now,
    backoff,
    onSellerFailure: () => {
      if (abortOnFailure) caller.abort();
    },
  };
  await assert.rejects(
    selectWinner(prepared, options, new Set(), caller.signal, config.request),
    { name: 'AbortError' },
  );
  assert.equal(prepared.stats.rows.size, 0);
  const afterDiscardedReset = backoff.failed(source.catalog.nodeId);
  abortOnFailure = false;
  await selectWinner(
    prepared,
    options,
    new Set(),
    new AbortController().signal,
    config.request,
  );
  assert.deepEqual(
    {
      afterDiscardedReset,
      afterDiscardedIncrement:
        prepared.stats.rows.get(other.catalog.nodeId)!.cooldownUntil! -
        source.context.now(),
    },
    {
      afterDiscardedReset: BUYER_SELECTION.cooldownMs * 4,
      afterDiscardedIncrement: BUYER_SELECTION.cooldownMs,
    },
  );
});

void test('a deferred failure report that cancels the caller retains ownership of retiring connections', async (context) => {
  await isolatedHome(context);
  const source = await controlFixture(true);
  const other = await controlFixture(true);
  const config = configuration(source, other);
  const caller = new AbortController();
  let release = () => {};
  const closing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reported = () => {};
  const cancelled = new Promise<void>((resolve) => {
    reported = resolve;
  });
  const failed = Object.assign(memorySeller(source).client(), {
    getCatalog: async () => {
      throw new Error('Synthetic unreachable seller');
    },
    close: () => closing,
  });
  const alternative = memorySeller(other);
  let finished = false;
  const pending = selectVerifiedBuyerQuote(
    config,
    {
      buyer: source.request.params.buyer,
      stats: new Map<string, LocalSellerStats>(),
      backoff: createSellerBackoff(),
      now: source.context.now,
      random: () => 0,
      connect: async (seller) =>
        seller.nodeId === source.catalog.nodeId ? failed : alternative.client(),
      onSellerFailure: () => {
        caller.abort();
        reported();
      },
    },
    caller.signal,
  ).then(() => {
    finished = true;
  });
  try {
    await cancelled;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
  } finally {
    release();
    await pending;
  }
});
