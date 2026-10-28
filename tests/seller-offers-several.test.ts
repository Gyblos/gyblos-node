// Startup with several offers: each is warmed in gyblos.toml order, the seller starts with the ready ones,
// and the others are warmed again in the background until ready or stopped. Synthetic engine plugins and
// memory snapshots; no network or processes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { OFFER_LIFETIME_MS } from '@gyblos/core/constants';
import type { PreparedEngine } from '@gyblos/node/engine-factory';
import type { LiveSellerOffer } from '@gyblos/node/seller-offer-set';
import {
  liveSellerOffer,
  prepareSellerOffers,
  retrySellerOffers,
} from '@gyblos/node/seller-offers';
import type { SellerOfferSettings } from '@gyblos/node/seller-settings';
import {
  CONTROL_METERING_MODES,
  ENGINE_DONE_REASONS,
  ENGINE_KINDS,
  MODEL_CLASSIFICATIONS,
  MODEL_IDENTITIES,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { MemorySnapshot } from '@gyblos/runtime/memory';

const SNAPSHOT: MemorySnapshot = {
  source: 'linux-memavailable',
  vmAvailableBytes: 8 * 1024 ** 3,
  cgroup: null,
};
const NO_HEADROOM: MemorySnapshot = { ...SNAPSHOT, vmAvailableBytes: 1 };

function offerSettings(index: number, modelId: string): SellerOfferSettings {
  return {
    offer: {
      modelId,
      reasoning: [REASONING_LEVELS.OFF],
      kind: OFFER_PRICING_KINDS.FREE,
      caps: { dailyTokenCap: 100, perBuyerCap: 100 },
    },
    engine: {
      index,
      model: { kind: MODEL_CLASSIFICATIONS.CUSTOM, id: modelId },
      engine: { kind: ENGINE_KINDS.OLLAMA, url: `http://127.0.0.1:1/${index}` },
      reasoning: [REASONING_LEVELS.OFF],
    },
  };
}

// One synthetic plugin per offer index; `up` decides whether its engine answers.
function plugins(local = false) {
  const up = new Map<number, boolean>();
  const warmups: number[] = [];
  const create = (offer: SellerOfferSettings['engine']): PreparedEngine => ({
    selection: { modelId: offer.model.id, variant: null, quantization: 'Q8_0' },
    metering: {
      mode: CONTROL_METERING_MODES.RECOUNTED,
      tokenizer: async () => ({ count: () => 1, input: () => 1 }),
    },
    readiness: {
      warmup: { prompt: 'hi', maxTokens: 1 },
      residencyMs: OFFER_LIFETIME_MS * 2,
      localResources: local,
    },
    engine: {
      describe: async () => {
        if (!up.get(offer.index)) throw new Error('down');
        return {
          name: offer.model.id,
          digest: `sha256:${offer.index}`,
          contextTokens: 4096,
        };
      },
      capabilities: () => ({
        reportsUsage: true,
        logprobs: false,
        cancellable: true,
        recountable: true,
        modelIdentity: MODEL_IDENTITIES.DIGEST,
      }),
      generate: async () => {
        warmups.push(offer.index);
        return {
          text: 'ok',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
          finishReason: ENGINE_DONE_REASONS.STOP,
        };
      },
    },
  });
  return { up, warmups, create };
}

const dependencies = (
  run: ReturnType<typeof plugins>,
  snapshot = SNAPSHOT,
  records: number[] = [],
) => ({
  fetch: globalThis.fetch,
  environment: {},
  snapshot: async () => snapshot,
  record: async (index: number) => {
    records.push(index);
  },
  create: run.create,
});

const SETTINGS = {
  offers: [offerSettings(0, 'model-a'), offerSettings(1, 'model-b')],
};

void test('every offer is warmed in order and the seller starts with the ready ones', async () => {
  const run = plugins();
  run.up.set(1, true);
  const records: number[] = [];
  const { ready, pending } = await prepareSellerOffers(
    SETTINGS,
    dependencies(run, SNAPSHOT, records),
  );
  assert.deepEqual(
    ready.map((offer) => offer.settings.engine.index),
    [1],
  );
  assert.deepEqual(
    pending.map((offer) => offer.settings.engine.index),
    [0],
  );
  assert.deepEqual(records, [0, 1]);
});

void test('with no offer ready startup fails with the first offer’s reason', async () => {
  const run = plugins();
  await assert.rejects(
    prepareSellerOffers(SETTINGS, dependencies(run)),
    /warmup failed/,
  );
});

void test('memory headroom gates only engines on this machine', async () => {
  const remote = plugins(false);
  remote.up.set(0, true);
  remote.up.set(1, true);
  const started = await prepareSellerOffers(
    SETTINGS,
    dependencies(remote, NO_HEADROOM),
  );
  assert.equal(started.ready.length, 2);
  const local = plugins(true);
  local.up.set(0, true);
  await assert.rejects(
    prepareSellerOffers(SETTINGS, dependencies(local, NO_HEADROOM)),
    /Insufficient memory headroom/,
  );
});

void test('an offer not ready at startup is warmed again and added once it is', async () => {
  const run = plugins();
  run.up.set(0, true);
  const { pending } = await prepareSellerOffers(SETTINGS, dependencies(run));
  const added: LiveSellerOffer[] = [];
  const retry = retrySellerOffers(pending, {
    ...dependencies(run),
    retryMs: 1,
    add: async (offer) => {
      added.push(offer);
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(added.length, 0);
    assert.deepEqual(retry.pending(), [1]);
    run.up.set(1, true);
    while (!added.length)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(added[0]!.index, 1);
    assert.equal(added[0]!.offer.modelId, 'model-b');
    assert.deepEqual(retry.pending(), []);
  } finally {
    await retry.stop();
  }
});

void test('stopping the retry ends it; nothing is added afterwards', async () => {
  const run = plugins();
  run.up.set(0, true);
  const { pending } = await prepareSellerOffers(SETTINGS, dependencies(run));
  const added: LiveSellerOffer[] = [];
  const retry = retrySellerOffers(pending, {
    ...dependencies(run),
    retryMs: 1,
    add: async (offer) => {
      added.push(offer);
    },
  });
  await retry.stop();
  run.up.set(1, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(added, []);
});

void test('a live offer refuses an engine selection that is not its listed model', async () => {
  const run = plugins();
  run.up.set(0, true);
  const { ready } = await prepareSellerOffers(
    { offers: [offerSettings(0, 'model-a')] },
    dependencies(run),
  );
  const warmed = ready[0]!;
  await assert.rejects(
    liveSellerOffer(
      {
        ...warmed,
        prepared: {
          ...warmed.prepared,
          selection: { ...warmed.prepared.selection, modelId: 'model-z' },
        },
      },
      { snapshot: async () => SNAPSHOT },
    ),
    /does not match/,
  );
});

void test('an offer that warms but cannot be served is dropped, not warmed again forever', async () => {
  const run = plugins();
  run.up.set(0, true);
  const { pending } = await prepareSellerOffers(SETTINGS, dependencies(run));
  run.up.set(1, true);
  let adds = 0;
  const retry = retrySellerOffers(pending, {
    ...dependencies(run),
    retryMs: 1,
    add: async () => {
      adds++;
      throw new Error('refused');
    },
  });
  try {
    while (!adds) await new Promise((resolve) => setTimeout(resolve, 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(adds, 1);
    assert.deepEqual(retry.pending(), []);
  } finally {
    await retry.stop();
  }
});
