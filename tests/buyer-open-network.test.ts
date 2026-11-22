// The shared init and automatic-buyer selection use verified open discovery at zero price ceilings.
// Configured sellers keep their original policy; cancellation and explicit opt-in precede selection.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FreeSelectionFailure } from '@gyblos/buyer/free-execution';
import { selectConfiguredThenOpen } from '@gyblos/buyer/quote-selection';
import {
  parseBuyerSelectionConfig,
  type BuyerSelectionConfig,
} from '@gyblos/buyer/selection-config';
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
  });

type Request = BuyerSelectionConfig['request'];

function recorder(results: (() => Promise<string>)[]) {
  const calls: { request: Request; route?: { open: true } }[] = [];
  return {
    calls,
    select: (request: Request, route?: { open: true }) => {
      calls.push({
        request,
        ...(route ? { route } : {}),
      });
      return results[calls.length - 1]!();
    },
  };
}

function config(sellers: number, open: boolean): BuyerSelectionConfig {
  const plan = buildBuyerInit(answers());
  return parseBuyerSelectionConfig({
    ...plan,
    sellers: Array.from({ length: sellers }, (_, index) => ({
      ...plan.sellers[0],
      nodeId: index.toString(16).padStart(64, '0'),
    })),
    discovery: { ...plan.discovery, ...(open ? { open: true } : {}) },
  });
}
const request: Request = {
  ...config(1, false).request,
  ...PAID,
  maxTokens: 4096,
};

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

void test('an already-cancelled selection never calls configured or open candidates', async () => {
  for (const policy of [config(0, true), config(1, true)]) {
    const controller = new AbortController();
    const reason = new Error('synthetic cancellation');
    controller.abort(reason);
    const run = recorder([async () => 'late winner']);
    await assert.rejects(
      selectConfiguredThenOpen(policy, request, controller.signal, run.select),
      (error: unknown) => error === reason,
    );
    assert.equal(run.calls.length, 0);
  }
});

void test('an empty candidate list does not authorize open discovery by itself', async () => {
  const run = recorder([async () => 'unrequested open winner']);
  await assert.rejects(
    selectConfiguredThenOpen(
      { sellers: [] },
      request,
      new AbortController().signal,
      run.select,
    ),
    (error: unknown) =>
      error instanceof FreeSelectionFailure &&
      error.decision.code === SELLER_SELECTION_CODES.NO_CANDIDATES,
  );
  assert.equal(run.calls.length, 0);
});

void test('a winner resolving after cancellation cannot escape either selection route', async () => {
  for (const policy of [config(0, true), config(1, true)]) {
    const controller = new AbortController();
    const reason = new Error('synthetic late cancellation');
    const run = recorder([
      async () => {
        controller.abort(reason);
        return 'late winner';
      },
    ]);
    await assert.rejects(
      selectConfiguredThenOpen(policy, request, controller.signal, run.select),
      (error: unknown) => error === reason,
    );
    assert.equal(run.calls.length, 1);
  }
});

void test('Auto discovers a paid seller at the effective key and tariff ceilings without a pin', async () => {
  const base = config(0, true);
  const auto = parseBuyerSelectionConfig({
    ...base,
    discovery: { ...base.discovery, paidAuto: true },
  });
  const selection = recorder([async () => 'eligible seller']);
  const bounded = { ...request, maxAtomic: '9' };
  assert.equal(
    await selectConfiguredThenOpen(
      auto,
      bounded,
      new AbortController().signal,
      selection.select,
    ),
    'eligible seller',
  );
  assert.deepEqual(selection.calls, [
    { request: bounded, route: { open: true } },
  ]);
});

void test('paid automatic discovery requires open discovery and a channel policy', () => {
  const base = config(1, false);
  assert.throws(() =>
    parseBuyerSelectionConfig({
      ...base,
      discovery: { ...base.discovery, paidAuto: true },
    }),
  );
  assert.throws(() =>
    parseBuyerSelectionConfig({
      ...base,
      session: undefined,
      request: { ...base.request, ...FREE },
      discovery: { ...base.discovery, open: true, paidAuto: true },
    }),
  );
});

void test('Auto never spends on a free key and rejects an existing seller pin', async () => {
  const base = config(0, true);
  const auto = parseBuyerSelectionConfig({
    ...base,
    discovery: { ...base.discovery, paidAuto: true },
  });
  const rec = recorder([async () => 'free']);
  await selectConfiguredThenOpen(
    auto,
    { ...request, maxAtomic: '0' },
    new AbortController().signal,
    rec.select,
  );
  assert.deepEqual(rec.calls[0]?.request.priceCeilings, FREE.priceCeilings);
  assert.throws(() =>
    parseBuyerSelectionConfig({ ...auto, pinnedNodeId: sellerNodeId }),
  );
});
