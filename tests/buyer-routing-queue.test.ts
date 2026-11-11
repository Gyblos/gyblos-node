// Waiting owns no financial effect and refreshes the exact seller's quote only after FIFO admission.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import { BUYER_BUSY_POLICIES, BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { createBuyerRouter, type BuyerRoutePorts } from '@gyblos/node/buyer-routing';

import { batchDeferred } from './support/batch-deferred';
import { multisellerSession } from './support/multiseller-session';

async function fixture(queueWaitMs = 1000) {
  const source = await multisellerSession();
  let quotes = 0;
  const router = createBuyerRouter({ policy: parseBuyerRoutingPolicy({ onBusy: BUYER_BUSY_POLICIES.WAIT, queueWaitMs, allowPinnedFallback: true }), pinnedNodeId: source.a.terms.sellerNodeId, priceCeilings: { inputAtomicPerMtok: '9000000', outputAtomicPerMtok: '9000000' }, unresolved: async () => false, reference: async () => source.offers[0]!.base.prices });
  const ports: BuyerRoutePorts<string> = { select: async (_excluded, _signal, route) => {
    assert.equal(route.pinnedNodeId, source.a.terms.sellerNodeId);
    const quote = await source.offers[0]!.quote(++quotes);
    return { nodeId: quote.offer.nodeId, quote };
  }, free: async () => assert.fail('priced quote'), paid: async () => 'answer' };
  return { router, source, ports, quotes: () => quotes, close: async () => { await router.close(); await source.close(); } };
}
void test('queue policy validates a bounded wait and defaults to thirty seconds', () => {
  assert.equal(parseBuyerRoutingPolicy({ onBusy: BUYER_BUSY_POLICIES.WAIT }).queueWaitMs, 30000);
  for (const queueWaitMs of [0, -1, 0.5, 180001, null]) assert.throws(() => parseBuyerRoutingPolicy({ onBusy: BUYER_BUSY_POLICIES.WAIT, queueWaitMs }), { code: BUYER_ROUTING_CODES.INVALID });
});
void test('a busy pinned seller waits without rerouting, then gets a new quote and executes exactly once', async (t) => {
  const host = await fixture(); t.after(host.close);
  const entered = batchDeferred<void>(); const finish = batchDeferred<void>();
  t.after(() => finish.resolve()); let calls = 0;
  const first = host.router.execute({ ...host.ports, paid: async () => { calls++; entered.resolve(); await finish.promise; return 'first'; } }, AbortSignal.timeout(3000));
  await entered.promise; const before = host.quotes();
  const second = host.router.execute({ ...host.ports, paid: async () => { calls++; return 'second'; } }, AbortSignal.timeout(3000));
  await setImmediate(); assert.equal(calls, 1); assert.equal(host.quotes(), before);
  finish.resolve(); await first;
  assert.equal((await second).result, 'second'); assert.equal(calls, 2); assert.ok(host.quotes() > before);
});
void test('queue timeout is typed and never runs the waiting execution port', async (t) => {
  const host = await fixture(5); t.after(host.close);
  const entered = batchDeferred<void>(); const finish = batchDeferred<void>();
  t.after(() => finish.resolve()); let calls = 0;
  const first = host.router.execute({ ...host.ports, paid: async () => { calls++; entered.resolve(); await finish.promise; return 'first'; } }, AbortSignal.timeout(3000));
  await entered.promise;
  try { await assert.rejects(host.router.execute(host.ports, AbortSignal.timeout(3000)), { code: BUYER_ROUTING_CODES.QUEUE_TIMEOUT }); assert.equal(calls, 1); }
  finally { finish.resolve(); await first; }
});
void test('disconnect removes a waiting request without executing it or retaining its admission slot', async (t) => {
  const host = await fixture(); t.after(host.close);
  const entered = batchDeferred<void>(); const finish = batchDeferred<void>();
  t.after(() => finish.resolve()); let calls = 0;
  const first = host.router.execute({ ...host.ports, paid: async () => { calls++; entered.resolve(); await finish.promise; return 'first'; } }, AbortSignal.timeout(3000));
  await entered.promise;
  const cancel = new AbortController();
  const second = assert.rejects(host.router.execute({ ...host.ports, paid: async () => { calls++; return 'unexpected'; } }, cancel.signal));
  await setImmediate(); cancel.abort(); await second;
  finish.resolve(); await first; assert.equal(calls, 1); assert.equal(host.router.activeRequests(), 0);
});
void test('a granted waiter keeps its seller while refreshing, so a newcomer cannot pass it', async (t) => {
  const host = await fixture(); t.after(host.close);
  const entered = batchDeferred<void>(); const finish = batchDeferred<void>();
  const refreshing = batchDeferred<void>(); const refreshed = batchDeferred<void>();
  t.after(() => { finish.resolve(); refreshed.resolve(); }); const order: string[] = [];
  const first = host.router.execute({ ...host.ports, paid: async () => { order.push('first'); entered.resolve(); await finish.promise; return 'first'; } }, AbortSignal.timeout(3000));
  await entered.promise;
  const second = host.router.execute({ ...host.ports, select: async (...args) => { refreshing.resolve(); await refreshed.promise; return host.ports.select(...args); }, paid: async () => { order.push('second'); return 'second'; } }, AbortSignal.timeout(3000));
  await setImmediate(); finish.resolve(); await first; await refreshing.promise;
  const third = host.router.execute({ ...host.ports, paid: async () => { order.push('third'); return 'third'; } }, AbortSignal.timeout(3000));
  await setImmediate(); assert.deepEqual(order, ['first']); refreshed.resolve();
  await second; await third; assert.deepEqual(order, ['first', 'second', 'third']);
});
