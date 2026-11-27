// Protects the offer summary's network-wide fields: models with a free seller are counted once per model
// (the same id with another quantization is another model), and the lowest paid input and output prices
// are each the minimum over every model's paid offers, ignoring offers free on both sides, and null when
// nothing is paid.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { OfferedModel, Seller } from '@gyblos/explorer/discovery';
import { summarizeOffers } from '@gyblos/explorer/offers';

const offer = (
  modelId: string,
  input: string,
  output: string,
  quantization: string | null = null,
): OfferedModel => ({
  modelId,
  variant: null,
  quantization,
  contextTokens: 4096,
  pricing: { inputAtomicPerMtok: input, outputAtomicPerMtok: output },
});
const seller = (nodeId: string, models: OfferedModel[]): Seller => ({
  nodeId,
  owner: 'o',
  models,
  uptime: null,
});
const summary = (sellers: Seller[]) =>
  summarizeOffers({
    generatedAt: 0,
    network: null,
    datedAt: null,
    networkDatedAt: null,
    models: {},
    error: null,
    sellers,
  });

void test('models with a free seller are counted once each, a quantization being its own model', () => {
  const result = summary([
    // m1 free twice, m2 free under two quantizations, m3 paid only.
    seller('a', [offer('m1', '0', '0'), offer('m2', '0', '0')]),
    seller('b', [offer('m1', '0', '0'), offer('m2', '0', '0', 'Q4')]),
    seller('c', [offer('m3', '1', '1')]),
  ]);
  // Not the free offers (4), not the sellers with one (2), not the model ids (2): m1, m2 and m2/Q4.
  assert.equal(result.freeModels, 3);
  assert.equal(result.offers, 5);
  assert.equal(result.free, 4);
});

void test('the lowest paid prices are each taken over every model and skip offers free on both sides', () => {
  const result = summary([
    seller('a', [offer('m1', '0', '0'), offer('m1', '50', '30')]),
    // Free input alone is still a paid offer.
    seller('b', [offer('m2', '0', '80')]),
    seller('c', [offer('m3', '12', '9')]),
    seller('d', [offer('m4', '40', '60')]),
  ]);
  // Neither minimum comes from the first or the last model, and they come from different models.
  assert.equal(result.minInput, 0n);
  assert.equal(result.minOutput, 9n);
  assert.equal(result.free, 1);
});

void test('without a paid offer the lowest prices are null, and an empty index has no free model', () => {
  const free = summary([seller('a', [offer('m1', '0', '0')])]);
  assert.equal(free.minInput, null);
  assert.equal(free.minOutput, null);
  assert.equal(free.freeModels, 1);
  const empty = summary([]);
  assert.equal(empty.freeModels, 0);
  assert.equal(empty.minInput, null);
  assert.equal(empty.minOutput, null);
});
