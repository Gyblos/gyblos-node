// One public selection owns native work across its remembered-quote and fresh-snapshot passes.
// Signed in-memory sellers and a held native SDK dial avoid sockets, real homes and payments.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import { createSnapshotCache } from '@gyblos/buyer/selection-cache';
import type { BuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';
import { CONTROL_CODES, CONTROL_METHODS } from '@gyblos/protocol/constants';
import { controlFail } from '@gyblos/protocol/control-validation';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';

import { controlFixture } from './support/control-fixture';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(operation: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Synthetic test watchdog expired')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function isolatedHome(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-stale-cancellation-'));
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

void test('caller cancellation in the stale retry waits for native work retired by the first quote pass', async (context) => {
  await isolatedHome(context);
  const sources = await Promise.all([
    controlFixture(true),
    controlFixture(true),
  ]);
  const source = sources[0]!;
  const services = sources.map((entry) =>
    createSellerControlService({
      context: entry.context,
      ownerSigner: entry.ownerSigner,
      nodeSigner: entry.nodeSigner,
    }),
  );
  const {
    buyer,
    buyerNodeId,
    catalogDigest: _digest,
    ...request
  } = source.request.params;
  const sellers = sources.map(({ catalog }) => ({
    owner: catalog.owner,
    nodeId: catalog.nodeId,
    relayUrl: null,
    directAddresses: [],
  }));
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
  const snapshots = createSnapshotCache();
  const deadStarted = deferred();
  const freshStarted = deferred();
  let exercisingRetry = false;
  let refusedRemembered = false;
  let nativeDials = 0;
  let nativeCloses = 0;
  let releaseNative = (_connection: Connection) => {};
  const endpoint = {
    id: () => ({ toString: () => buyerNodeId }),
    connect: () => {
      nativeDials++;
      deadStarted.resolve();
      return new Promise<Connection>((resolve) => {
        releaseNative = resolve;
      });
    },
  } as unknown as Endpoint;
  const memoryClient = (index: number) => {
    const client = createBuyerControlClient(
      {
        localNodeId: buyerNodeId,
        remoteNodeId: sellers[index]!.nodeId,
        exchange: async (value, signal) => {
          if (
            exercisingRetry &&
            index === 0 &&
            typeof value === 'object' &&
            value !== null &&
            'method' in value &&
            value.method === CONTROL_METHODS.CATALOG
          ) {
            freshStarted.resolve();
            return new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) reject(signal.reason);
              else
                signal?.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                });
            });
          }
          return services[index]!.respond(
            value,
            buyerNodeId,
            signal ?? new AbortController().signal,
          );
        },
        close: async () => {},
      },
      { ...sources[index]!.trust(), now: sources[index]!.context.now },
    );
    const requestOffer = client.requestOffer.bind(client);
    return Object.assign(client, {
      requestOffer: async (...args: Parameters<typeof requestOffer>) => {
        if (exercisingRetry && index === 0 && !refusedRemembered) {
          await deadStarted.promise;
          refusedRemembered = true;
          return controlFail(CONTROL_CODES.STALE);
        }
        return requestOffer(...args);
      },
    });
  };
  const dependencies = {
    buyer,
    snapshots,
    stats: new Map<string, LocalSellerStats>(),
    now: source.context.now,
    random: () => 0,
    connect: async (seller: { nodeId: string }) => {
      const index = sellers.findIndex(
        (entry) => entry.nodeId === seller.nodeId,
      );
      if (!exercisingRetry || index !== 1) return memoryClient(index);
      const client = createBuyerControlClient(
        createControlTransport(
          endpoint,
          {} as EndpointAddr,
          sellers[1]!.nodeId,
          {
            queryMs: 10_000,
          },
        ),
        { ...sources[1]!.trust(), now: sources[1]!.context.now },
      );
      return {
        getCatalog: (...args: Parameters<typeof client.getCatalog>) =>
          client.getCatalog(...args),
        getPresence: (...args: Parameters<typeof client.getPresence>) =>
          client.getPresence(...args),
        useCatalog: (...args: Parameters<typeof client.useCatalog>) =>
          client.useCatalog(...args),
        requestOffer: (...args: Parameters<typeof client.requestOffer>) =>
          client.requestOffer(...args),
        async close() {
          await client.close();
          await client.settled();
        },
      };
    },
  };
  assert.equal((await selectVerifiedBuyerQuote(config, dependencies)).ok, true);
  assert.ok(snapshots.get(sellers[0]!, source.context.now()));
  assert.ok(snapshots.get(sellers[1]!, source.context.now()));
  exercisingRetry = true;
  const caller = new AbortController();
  let finished = false;
  const pending = selectVerifiedBuyerQuote(
    config,
    dependencies,
    caller.signal,
  ).then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    await within(freshStarted.promise, 3000);
    assert.equal(refusedRemembered, true);
    assert.equal(nativeDials, 1);
    assert.equal(snapshots.retiring(sellers[1]!.nodeId), true);
    caller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      { finished, nativeDials, nativeCloses },
      { finished: false, nativeDials: 1, nativeCloses: 0 },
      'the outer selection still owns the first pass native dial during retry cancellation',
    );
  } finally {
    caller.abort();
    releaseNative({
      close() {
        nativeCloses++;
      },
    } as unknown as Connection);
    await within(pending, 2000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nativeCloses, 1);
    assert.equal(snapshots.retiring(sellers[1]!.nodeId), false);
  }
});
