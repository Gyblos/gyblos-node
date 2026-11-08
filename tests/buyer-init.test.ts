// Pure guided settings must round-trip the existing runtime parser without weakening policy.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import {
  DEVNET,
  DEVNET_RPC_URL,
  DEVNET_USDC,
  INFERENCE_REQUEST_LIMITS,
} from '@gyblos/config';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { MODEL } from '@gyblos/engine-ollama/model';
import {
  buildBuyerInit,
  buyerInitDefaults,
  BuyerInitError,
} from '@gyblos/node/buyer-init';
import { BUYER_INIT_CODES } from '@gyblos/node/buyer-init-constants';
import {
  DATA_RETENTION,
  MODEL_IDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { answers, sellerNodeId } from './support/buyer-init';

void test('guided defaults admit only free quotes and preserve current bounded model selection', () => {
  const defaults = buyerInitDefaults();
  assert.equal(defaults.modelId, MODEL_IDS.QWEN3_0_6B);
  assert.equal(defaults.quantization, MODEL.quantization);
  assert.equal(
    defaults.maxTokens,
    String(INFERENCE_REQUEST_LIMITS.maxOutputTokens),
  );
  assert.equal(defaults.maxUsdc, '0');
  assert.equal(defaults.inputUsdcPerMtok, '0');
  assert.equal(defaults.outputUsdcPerMtok, '0');
  assert.equal(defaults.sellerOwner, '');
  assert.equal(defaults.sellerNodeId, '');
});
void test('shared plan round-trips the runtime parser with independent 8004 verification enabled', () => {
  const parsed = parseBuyerSelectionConfig(buildBuyerInit(answers()));
  assert.equal(parsed.request.maxAtomic, '0');
  assert.equal(parsed.request.reasoning, REASONING_LEVELS.OFF);
  assert.equal(parsed.request.lowestReasoning, null);
  assert.equal(parsed.request.minimumBadge, SELLER_BADGES.DECLARED_USAGE);
  assert.deepEqual(parsed.request.retention, [DATA_RETENTION.NONE]);
  assert.equal(parsed.request.network, DEVNET);
  assert.equal(parsed.request.asset, DEVNET_USDC);
  assert.deepEqual(parsed.identity, { rpcUrl: DEVNET_RPC_URL });
  assert.equal(parsed.sellers[0]?.manualTrust, false);
  assert.deepEqual(parsed.sellers[0]?.directAddresses, []);
});
void test('USDC ceilings convert exactly without making a positive budget a paid-only mode', () => {
  const plan = buildBuyerInit({
    ...answers(),
    maxUsdc: '0.01',
    inputUsdcPerMtok: '0.10',
    outputUsdcPerMtok: '0.000001',
  });
  assert.equal(plan.request.maxAtomic, '10000');
  assert.deepEqual(plan.request.priceCeilings, {
    inputAtomicPerMtok: '100000',
    outputAtomicPerMtok: '1',
  });
  assert.equal(
    buildBuyerInit({ ...answers(), maxUsdc: '1' }).request.priceCeilings
      .inputAtomicPerMtok,
    '0',
  );
});
void test('USDC conversion preserves the full u64 ceiling without number rounding', () => {
  const largest = '18446744073709.551615';
  const plan = buildBuyerInit({
    ...answers(),
    maxUsdc: largest,
    inputUsdcPerMtok: largest,
  });
  assert.equal(plan.request.maxAtomic, '18446744073709551615');
  assert.equal(
    plan.request.priceCeilings.inputAtomicPerMtok,
    '18446744073709551615',
  );
  assert.throws(
    () => buildBuyerInit({ ...answers(), maxUsdc: '18446744073709.551616' }),
    { code: BUYER_INIT_CODES.INVALID },
  );
});

void test('exact custom selection is preserved without aliases or silent reasoning downgrades', () => {
  const selection = buildBuyerInit({
    ...answers(),
    modelId: 'custom/model',
    variant: 'revision-a',
    quantization: 'custom-q',
  }).request.selection;
  assert.deepEqual(selection, {
    modelId: 'custom/model',
    variant: 'revision-a',
    quantization: 'custom-q',
  });
});
void test('malformed identities, unknown fields and token bounds refuse static typed errors', () => {
  for (const input of [
    { ...answers(), sellerNodeId: sellerNodeId.toUpperCase() },
    { ...answers(), sellerOwner: 'private-invalid-value' },
    { ...answers(), maxTokens: '129' },
    { ...answers(), maxTokens: '01' },
    { ...answers(), maxTokens: '1e2' },
    { ...answers(), manualTrust: true },
    { ...answers(), reasoning: REASONING_LEVELS.HIGH },
  ]) {
    assert.throws(
      () => buildBuyerInit(input),
      (error: unknown) =>
        error instanceof BuyerInitError &&
        error.code === BUYER_INIT_CODES.INVALID &&
        !error.message.includes('private-invalid-value'),
    );
  }
});
void test('USDC precision, canonical decimal spelling and overflow are bounded before bigint conversion', () => {
  for (const value of [
    '0010',
    '-1',
    '1e3',
    '0.0000001',
    '18446744073710',
    '9'.repeat(2049),
  ]) {
    for (const field of ['maxUsdc', 'inputUsdcPerMtok', 'outputUsdcPerMtok'])
      assert.throws(() => buildBuyerInit({ ...answers(), [field]: value }), {
        code: BUYER_INIT_CODES.INVALID,
      });
  }
});
void test('configuration refuses credentialed or unsafe URLs and unconfigured relays', () => {
  for (const field of ['discoveryUrl', 'rpcUrl'])
    for (const url of [
      'http://remote.example/v1',
      'https://user:private-token@example.test/v1',
      'https://example.test/v1?key=private-token',
      'https://example.test/v1#private-token',
    ])
      assert.throws(() => buildBuyerInit({ ...answers(), [field]: url }), {
        code: BUYER_INIT_CODES.INVALID,
      });
  assert.throws(
    () =>
      buildBuyerInit({
        ...answers(),
        relayUrl: 'https://unconfigured.example/',
      }),
    { code: BUYER_INIT_CODES.INVALID },
  );
  assert.equal(
    buildBuyerInit({
      ...answers(),
      rpcUrl: 'http://127.0.0.1:9',
      discoveryUrl: 'http://127.0.0.1:10/v1',
    }).identity.rpcUrl,
    'http://127.0.0.1:9',
  );
});
