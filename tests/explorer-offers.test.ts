// Protects the offer summary's network-wide fields: models with a free seller are counted once per model,
// and the lowest paid input and output prices are each the minimum over every model's paid offers,
// ignoring free ones, and null when nothing is paid.
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
    error: null,
    sellers,
  });

void test('models with a free seller are counted once each, a quantization being its own model', () => {
  const result = summary([
    seller('a', [offer('m1', '0', '0'), offer('m2', '3', '4')]),
    seller('b', [offer('m1', '0', '0'), offer('m2', '0', '0', 'Q4')]),
    seller('c', [offer('m3', '1', '1')]),
  ]);
  // m1 (two free sellers) and m2/Q4; m2 and m3 are paid only.
  assert.equal(result.freeModels, 2);
  assert.equal(result.offers, 5);
  assert.equal(result.free, 3);
});

void test('the lowest paid prices are each taken over every model and skip free offers', () => {
  const result = summary([
    seller('a', [offer('m1', '0', '0'), offer('m1', '50', '9')]),
    seller('b', [offer('m2', '7', '80')]),
    seller('c', [offer('m3', '12', '20')]),
  ]);
  // Input and output minima can come from different models.
  assert.equal(result.minInput, 7n);
  assert.equal(result.minOutput, 9n);
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
