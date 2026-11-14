// A seller that stopped answering must not hold every request: its connection attempt ends with the
// snapshot deadline (not the 30 s transport timeout), a connection that arrives late is closed, and while
// it cools down it is not contacted again unless it is pinned. Synthetic loopback seller; real timers.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectBuyerQuote,
  type BuyerControlClient,
} from '@gyblos/buyer/selection';

import { selectionFixture } from './support/buyer-selection';

const DEAD = '3'.repeat(64);

async function rig() {
  const run = await selectionFixture();
  const healthy = run.config.sellers[0]!;
  const config = {
    ...run.config,
    sellers: [healthy, { ...healthy, nodeId: DEAD }],
  };
  const attempts: string[] = [];
  let arrive!: (client: BuyerControlClient) => void;
  let closed = 0;
  const late: BuyerControlClient = {
    getCatalog: async () => assert.fail('a late connection is not used'),
    getPresence: async () => assert.fail('a late connection is not used'),
    requestOffer: async () => assert.fail('a late connection is not used'),
    async close() {
      closed++;
    },
  };
  const dependencies = {
    ...run.dependencies,
    snapshotMs: 300,
    async connect(seller: { nodeId: string }) {
      attempts.push(seller.nodeId);
      if (seller.nodeId !== DEAD) return run.client;
      // Connects only after the whole selection is over, like a transport timing out at 30 s.
      return new Promise<BuyerControlClient>((resolve) => {
        arrive = resolve;
      });
    },
  };
  return {
    run,
    config,
    dependencies,
    attempts,
    arriveLate: () => arrive(late),
    closed: () => closed,
  };
}

void test('a seller whose connection hangs costs at most the snapshot deadline', async (t) => {
  const host = await rig();
  t.after(() => host.run.wire.close());
  const started = performance.now();
  const result = await selectBuyerQuote(host.config, host.dependencies);
  assert.equal(result.ok, true);
  assert.ok(performance.now() - started < 2000);
  assert.ok(host.dependencies.stats.get(DEAD)?.cooldownUntil);
  // The connection that finally arrives is closed, not leaked.
  host.arriveLate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.closed(), 1);
});

void test('a seller cooling down is not contacted again, unless it is pinned', async (t) => {
  const host = await rig();
  t.after(() => host.run.wire.close());
  await selectBuyerQuote(host.config, host.dependencies);
  host.attempts.length = 0;
  assert.equal(
    (await selectBuyerQuote(host.config, host.dependencies)).ok,
    true,
  );
  assert.equal(host.attempts.includes(DEAD), false);
  host.attempts.length = 0;
  const pinned = await selectBuyerQuote(
    { ...host.config, pinnedNodeId: DEAD },
    host.dependencies,
  );
  assert.equal(pinned.ok, false);
  assert.equal(host.attempts.includes(DEAD), true);
  host.arriveLate();
});

void test('a connection to a seller that stopped answering closes in the background', async (t) => {
  const run = await selectionFixture();
  t.after(() => run.wire.close());
  const healthy = run.config.sellers[0]!;
  let closing = 0;
  const stuck: BuyerControlClient = {
    // The connection is open but the seller never answers, so only the deadline ends the snapshot.
    getCatalog: (signal?: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
    getPresence: async () => assert.fail('unused'),
    requestOffer: async () => assert.fail('unused'),
    // Like a QUIC connection to a dead peer: closing waits for an idle timeout far beyond the test.
    close: () => {
      closing++;
      return new Promise<void>(() => undefined);
    },
  };
  const started = performance.now();
  const result = await selectBuyerQuote(
    { ...run.config, sellers: [healthy, { ...healthy, nodeId: DEAD }] },
    {
      ...run.dependencies,
      snapshotMs: 300,
      connect: async (seller) => (seller.nodeId === DEAD ? stuck : run.client),
    },
  );
  assert.equal(result.ok, true);
  assert.ok(performance.now() - started < 2000);
  assert.equal(closing, 1);
});

void test('a cooldown that ends during the snapshot does not skip the seller', async (t) => {
  const host = await rig();
  t.after(() => host.run.wire.close());
  const healthy = host.config.sellers[0]!.nodeId;
  const now = host.dependencies.now();
  // Cooling until just inside the snapshot window: selection, which reads the clock later, may use it.
  host.dependencies.stats.set(healthy, {
    successes: 0,
    failures: 1,
    latencyMs: 0,
    waitAccuracy: null,
    cooldownUntil: now + 100,
    quotedWaitMs: null,
    observedWaitMs: null,
  });
  await selectBuyerQuote(host.config, host.dependencies).catch(() => undefined);
  assert.equal(host.attempts.includes(healthy), true);
  host.arriveLate();
});

void test("a pinned seller's failed connection is closed before the request returns", async (t) => {
  const run = await selectionFixture();
  t.after(() => run.wire.close());
  const healthy = run.config.sellers[0]!;
  let closed = false;
  const stuck: BuyerControlClient = {
    getCatalog: (signal?: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
    getPresence: async () => assert.fail('unused'),
    requestOffer: async () => assert.fail('unused'),
    close: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      closed = true;
    },
  };
  await selectBuyerQuote(
    {
      ...run.config,
      sellers: [healthy, { ...healthy, nodeId: DEAD }],
      pinnedNodeId: DEAD,
    },
    {
      ...run.dependencies,
      snapshotMs: 300,
      connect: async (seller) => (seller.nodeId === DEAD ? stuck : run.client),
    },
  );
  assert.equal(closed, true);
});
