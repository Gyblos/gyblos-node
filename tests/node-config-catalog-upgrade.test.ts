// Upgrading across a catalog expansion: an offer written as `custom = true` for a model the catalog later
// adds (the Qwen3 sizes) keeps loading. It becomes the catalog model, with a warning to drop the flag, and
// the engine still asks its server for the name the operator wrote.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSellerEngine } from '@gyblos/node/engine-registry';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { sellerSettings } from '@gyblos/node/seller-settings';
import {
  CONTROL_METERING_MODES,
  MODEL_CLASSIFICATIONS,
} from '@gyblos/protocol/constants';

import { COMPLETE } from './support/fake-openai';
import { BASE, offer } from './support/node-config-fixtures';

const LOOPBACK =
  '{ kind = "openai", url = "http://127.0.0.1:11434/v1", context_tokens = 32768 }';
const FREE = 'free = { daily_token_cap = 200000, per_buyer_cap = 5000 }';

void test('a custom offer for a model the catalog now lists loads as that catalog model, with a warning', () => {
  const result = parseNodeConfig(
    BASE +
      offer({
        model: 'qwen3:8b',
        engine: LOOPBACK,
        pricing: FREE,
        extra: 'custom = true\nreasoning = ["off"]',
      }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.config.offers[0]!.model, {
    kind: MODEL_CLASSIFICATIONS.CATALOG,
    id: 'qwen3-8b',
    requested: 'qwen3:8b',
  });
  assert.deepEqual(result.warnings, [
    { code: 'CUSTOM_MODEL_NOW_IN_CATALOG', path: 'offers[0].custom' },
  ]);
});

void test('the upgraded offer is recounted and still asks its server for the name the operator wrote', async () => {
  const parsed = parseNodeConfig(
    BASE +
      offer({
        model: 'qwen3:8b',
        engine: LOOPBACK,
        pricing: FREE,
        extra: 'custom = true\nreasoning = ["off"]',
      }),
  );
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const [served] = sellerSettings(parsed.config, {}).offers;
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(COMPLETE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  const created = createSellerEngine(served!.engine, {
    fetch,
    environment: {},
  });
  assert.equal(created.metering.mode, CONTROL_METERING_MODES.RECOUNTED);
  await created.engine.generate({ prompt: 'synthetic', maxTokens: 8 });
  assert.equal(bodies[0]!.model, 'qwen3:8b');
});
