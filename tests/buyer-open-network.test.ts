// A buyer that names no seller uses the open network: any seller the index lists whose 8004 identity checks
// out, for free answers only. `buyer:init` writes that when the seller is left empty, and the automatic
// buyer (buyer:start, buyer:chat, the desktop app) asks its configured sellers first and falls back to the
// open network at zero ceilings, so a discovered seller is never paid.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FreeSelectionFailure } from '@gyblos/buyer/free-execution';
import { selectConfiguredThenOpen } from '@gyblos/buyer/quote-selection';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { buildBuyerInit, BuyerInitError } from '@gyblos/node/buyer-init';
import { BUYER_INIT_CODES } from '@gyblos/node/buyer-init-constants';

import { answers, sellerNodeId } from './support/buyer-init';

const PAID = {
  maxAtomic: '500000',
  priceCeilings: { inputAtomicPerMtok: '100', outputAtomicPerMtok: '400' },
};
const FREE = {
  maxAtomic: '0',
  priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
};
const unavailable = () =>
  new FreeSelectionFailure({
    ok: false,
    code: SELLER_SELECTION_CODES.NO_CANDIDATES,
  } as never);

function recorder(results: (() => Promise<string>)[]) {
  const calls: { request: Record<string, unknown>; route?: { open: true } }[] =
    [];
  return {
    calls,
    select: (request: object, route?: { open: true }) => {
      calls.push({
        request: request as Record<string, unknown>,
        ...(route ? { route } : {}),
      });
      return results[calls.length - 1]!();
    },
  };
}

const config = (sellers: number, open: boolean) =>
  ({
    sellers: Array.from({ length: sellers }, (_, index) => ({
      nodeId: String(index),
    })),
    ...(open
      ? { discovery: { baseUrl: 'https://index.test', open: true } }
      : {}),
  }) as never;
const request = { ...PAID, maxTokens: 4096 } as never;

void test('buyer:init with no seller writes an open-network buyer the runtime accepts', () => {
  const plan = buildBuyerInit({
    ...answers(),
    sellerNodeId: '',
    sellerOwner: '',
  });
  assert.deepEqual(plan.sellers, []);
  assert.equal(plan.discovery.open, true);
  const parsed = parseBuyerSelectionConfig(JSON.parse(JSON.stringify(plan)));
  assert.equal(parsed.discovery?.open, true);
  assert.deepEqual(parsed.sellers, []);
  // A named seller keeps the configured list without open discovery.
  const named = buildBuyerInit(answers());
  assert.equal(named.sellers[0]!.nodeId, sellerNodeId);
  assert.equal(named.discovery.open, undefined);
});

void test('buyer:init refuses a NodeId without its owner, or an owner without a NodeId', () => {
  for (const input of [
    { ...answers(), sellerOwner: '' },
    { ...answers(), sellerNodeId: '' },
  ])
    assert.throws(
      () => buildBuyerInit(input),
      (error: unknown) =>
        error instanceof BuyerInitError &&
        error.code === BUYER_INIT_CODES.INVALID,
    );
});

void test('an open-network buyer with no configured seller asks the index for free answers only', async () => {
  const run = recorder([async () => 'discovered']);
  const winner = await selectConfiguredThenOpen(
    config(0, true),
    request,
    new AbortController().signal,
    run.select,
  );
  assert.equal(winner, 'discovered');
  assert.equal(run.calls.length, 1);
  assert.deepEqual(run.calls[0]!.route, { open: true });
  assert.equal(run.calls[0]!.request.maxAtomic, FREE.maxAtomic);
  assert.deepEqual(run.calls[0]!.request.priceCeilings, FREE.priceCeilings);
});

void test('configured sellers come first at the request ceilings; the open network only when none can serve', async () => {
  const served = recorder([async () => 'configured']);
  assert.equal(
    await selectConfiguredThenOpen(
      config(1, true),
      request,
      new AbortController().signal,
      served.select,
    ),
    'configured',
  );
  assert.equal(served.calls.length, 1);
  assert.equal(served.calls[0]!.route, undefined);
  assert.equal(served.calls[0]!.request.maxAtomic, PAID.maxAtomic);

  const fallback = recorder([
    async () => {
      throw unavailable();
    },
    async () => 'discovered',
  ]);
  assert.equal(
    await selectConfiguredThenOpen(
      config(1, true),
      request,
      new AbortController().signal,
      fallback.select,
    ),
    'discovered',
  );
  assert.deepEqual(fallback.calls[1]!.route, { open: true });
  assert.equal(fallback.calls[1]!.request.maxAtomic, FREE.maxAtomic);
});

void test('without open discovery, after another error or after cancellation, nothing falls back', async () => {
  const closed = recorder([
    async () => {
      throw unavailable();
    },
  ]);
  await assert.rejects(
    selectConfiguredThenOpen(
      config(1, false),
      request,
      new AbortController().signal,
      closed.select,
    ),
    FreeSelectionFailure,
  );
  assert.equal(closed.calls.length, 1);

  const other = recorder([
    async () => {
      throw new Error('identity state unavailable');
    },
  ]);
  await assert.rejects(
    selectConfiguredThenOpen(
      config(1, true),
      request,
      new AbortController().signal,
      other.select,
    ),
    /identity state unavailable/,
  );
  assert.equal(other.calls.length, 1);

  const cancelled = new AbortController();
  const aborted = recorder([
    async () => {
      cancelled.abort();
      throw unavailable();
    },
  ]);
  await assert.rejects(
    selectConfiguredThenOpen(
      config(1, true),
      request,
      cancelled.signal,
      aborted.select,
    ),
    FreeSelectionFailure,
  );
  assert.equal(aborted.calls.length, 1);
});
