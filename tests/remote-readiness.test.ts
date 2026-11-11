// A remote engine the seller pays per call is ready when it describes its model: readiness and renewals
// never generate, and this machine's memory is not read. Synthetic engines and memory snapshots; no
// network or processes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { OFFER_LIFETIME_MS } from '@gyblos/core/constants';
import { observeControlReadiness } from '@gyblos/node/control-readiness';
import {
  REMOTE_READINESS,
  type PreparedEngine,
} from '@gyblos/node/engine-factory';
import { probeSellerEngine } from '@gyblos/node/engine-readiness';
import { DECLARED_METER } from '@gyblos/node/free-meter';
import {
  liveSellerOffer,
  prepareSellerOffers,
} from '@gyblos/node/seller-offers';
import type { SellerOfferSettings } from '@gyblos/node/seller-settings';
import {
  CONTROL_METERING_MODES,
  ENGINE_KINDS,
  MODEL_CLASSIFICATIONS,
  MODEL_IDENTITIES,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { Engine } from '@gyblos/protocol/engine';
import type { MemorySnapshot } from '@gyblos/runtime/memory';

const NOW = 1_000_000;
function remoteEngine() {
  const calls = { describe: 0, generate: 0 };
  const engine: Engine = {
    describe: async () => {
      calls.describe++;
      return { name: 'acme-chat', contextTokens: 131_072 };
    },
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: false,
      modelIdentity: MODEL_IDENTITIES.NAME_ONLY,
    }),
    generate: async () => {
      calls.generate++;
      throw new Error('a remote readiness check must not generate');
    },
  };
  return { engine, calls };
}

// Memory that cannot be observed at all, as on a host without cgroup memory files.
const UNOBSERVABLE = async (): Promise<MemorySnapshot> => {
  throw new Error('memory not observable');
};

void test('a remote engine is ready once described, without generating or reading memory', async () => {
  const { engine, calls } = remoteEngine();
  const ready = await probeSellerEngine(engine, new AbortController().signal, {
    policy: REMOTE_READINESS,
    snapshot: UNOBSERVABLE,
    now: () => NOW,
  });
  assert.deepEqual(ready, {
    model: { name: 'acme-chat', contextTokens: 131_072 },
    offerExpiresAt: NOW + OFFER_LIFETIME_MS,
  });
  assert.deepEqual(calls, { describe: 1, generate: 0 });
});

void test('a remote engine renews readiness by describing its model again, never generating', async () => {
  const { engine, calls } = remoteEngine();
  const model = { name: 'acme-chat', contextTokens: 131_072 };
  let now = NOW;
  const observation = observeControlReadiness(
    engine,
    NOW + OFFER_LIFETIME_MS,
    () => now,
    {
      model,
      check: (signal) =>
        probeSellerEngine(engine, signal, {
          policy: REMOTE_READINESS,
          snapshot: UNOBSERVABLE,
          now: () => now,
        }),
    },
  );
  now = NOW + OFFER_LIFETIME_MS - 1;
  assert.equal(await observation.tick(), true);
  assert.equal(observation.readiness().validUntil, now + OFFER_LIFETIME_MS);
  assert.deepEqual(calls, { describe: 1, generate: 0 });
});

void test('a remote offer is prepared and served with declared metering, never generating', async () => {
  const { engine, calls } = remoteEngine();
  const settings: SellerOfferSettings = {
    offer: {
      modelId: 'acme-chat',
      reasoning: [REASONING_LEVELS.OFF],
      kind: OFFER_PRICING_KINDS.FREE,
      caps: { dailyTokenCap: 100, perBuyerCap: 100, maxOutputTokens: 4096 },
    },
    engine: {
      index: 0,
      model: { kind: MODEL_CLASSIFICATIONS.CUSTOM, id: 'acme-chat' },
      engine: { kind: ENGINE_KINDS.OPENAI, url: 'https://api.example.com/v1' },
      reasoning: [REASONING_LEVELS.OFF],
    },
  };
  const prepared: PreparedEngine = {
    engine,
    selection: { modelId: 'acme-chat', variant: null, quantization: null },
    metering: { mode: CONTROL_METERING_MODES.DECLARED },
    readiness: REMOTE_READINESS,
  };
  const dependencies = {
    fetch: globalThis.fetch,
    environment: {},
    snapshot: UNOBSERVABLE,
    record: async () => {},
    create: () => prepared,
    now: () => NOW,
  };
  const { ready, pending } = await prepareSellerOffers(
    { offers: [settings] },
    dependencies,
  );
  assert.equal(pending.length, 0);
  const live = await liveSellerOffer(ready[0]!, dependencies);
  assert.equal(live.meteringMode, CONTROL_METERING_MODES.DECLARED);
  assert.equal(live.meter, DECLARED_METER);
  assert.equal(calls.generate, 0);
});
