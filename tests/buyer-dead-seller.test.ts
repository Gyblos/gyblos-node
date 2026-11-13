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
