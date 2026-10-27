// Checks exact per-million arithmetic and explicit v2 price boundaries without enabling execution.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import { parseOfferV2 } from '@gyblos/protocol/offer-v2';
import { parsePublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';

const prices = (input = '100000', output = '200000') => ({
  inputAtomicPerMtok: input,
  outputAtomicPerMtok: output,
});

void test('v2 prices charge fractional atomic values with a ceiling, never a floating-point product', async () => {
  const { chargeV2 } = await import('@gyblos/core/pricing-v2');
  assert.equal(chargeV2({ input: 0, output: 0 }, prices()), 0n);
  assert.equal(chargeV2({ input: 1, output: 0 }, prices()), 1n);
  assert.equal(chargeV2({ input: 10, output: 0 }, prices()), 1n);
  assert.equal(chargeV2({ input: 11, output: 0 }, prices()), 2n);
  assert.equal(chargeV2({ input: 1_000_000, output: 0 }, prices()), 100000n);
  assert.equal(chargeV2({ input: 0, output: 1 }, prices('0', '1')), 1n);
});

void test('v2 rounds the complete weighted input and output sum exactly once', async () => {
  const { chargeV2 } = await import('@gyblos/core/pricing-v2');
  assert.equal(chargeV2({ input: 1, output: 1 }, prices()), 1n);
  assert.equal(
    chargeV2({ input: 1000, output: 250 }, prices('150000', '350000')),
    238n,
  );
  assert.equal(
    chargeV2({ input: 2, output: 2 }, prices('250000', '250000')),
    1n,
  );
});

void test('v2 zero components and free prices do not invent a minimum charge', async () => {
  const { chargeV2 } = await import('@gyblos/core/pricing-v2');
  assert.equal(chargeV2({ input: 10, output: 20 }, prices('0', '0')), 0n);
  assert.equal(chargeV2({ input: 10, output: 0 }, prices('0', '100000')), 0n);
});

void test('v2 preserves integers above Number precision and allows oversized intermediates when the final u64 fits', async () => {
  const { chargeV2 } = await import('@gyblos/core/pricing-v2');
  assert.equal(
    chargeV2({ input: 1_000_000, output: 0 }, prices('9007199254740993', '0')),
    9007199254740993n,
  );
  const maximum = PUBLIC_RECORD_LIMITS.maxAtomic;
  assert.equal(
    chargeV2({ input: 999999, output: 1 }, prices(maximum, maximum)),
    BigInt(maximum),
  );
  assert.equal(
    chargeV2(
      { input: PUBLIC_RECORD_LIMITS.maxContextTokens, output: 0 },
      prices('1', '0'),
    ),
    10n,
  );
});

void test('v2 refuses final charge overflow, including overflow caused only by aggregation', async () => {
  const { chargeV2 } = await import('@gyblos/core/pricing-v2');
  const maximum = PUBLIC_RECORD_LIMITS.maxAtomic;
  assert.throws(
    () => chargeV2({ input: 1_000_001, output: 0 }, prices(maximum, '0')),
    { code: CONTROL_CODES.LIMIT },
  );
  assert.throws(
    () =>
      chargeV2(
        { input: 1_000_000, output: 1_000_000 },
        prices(maximum, maximum),
      ),
    { code: CONTROL_CODES.LIMIT },
  );
});

void test('v2 validates canonical prices and bounded counts before arithmetic with static errors', async () => {
  const { chargeV2 } = await import('@gyblos/core/pricing-v2');
  for (const input of [
    '01',
    '-1',
    '+1',
    '0.10',
    '1e6',
    '18446744073709551616',
    'PRIVATE_INPUT',
  ])
    assert.throws(() => chargeV2({ input: 1, output: 0 }, prices(input)), {
      code: CONTROL_CODES.INVALID,
      message: CONTROL_CODES.INVALID,
    });
  for (const input of [
    -1,
    0.1,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    PUBLIC_RECORD_LIMITS.maxContextTokens + 1,
  ])
    assert.throws(() => chargeV2({ input, output: 0 }, prices()), {
      code: CONTROL_CODES.INVALID,
    });
  assert.throws(
    () => chargeV2({ input: 1, output: 1 }, { ...prices(), inputAtomic: '1' }),
    { code: CONTROL_CODES.INVALID },
  );
});

void test('v2 legacy advertisement conversion scales exact rates and refuses an unrepresentable u64', async () => {
  const { atomicPerTokenPricesV2 } = await import('@gyblos/core/pricing-v2');
  assert.deepEqual(
    atomicPerTokenPricesV2({ inputAtomic: '1', outputAtomic: '2' }),
    prices('1000000', '2000000'),
  );
  assert.deepEqual(
    atomicPerTokenPricesV2({ inputAtomic: '0', outputAtomic: '0' }),
    prices('0', '0'),
  );
  assert.throws(
    () =>
      atomicPerTokenPricesV2({
        inputAtomic: PUBLIC_RECORD_LIMITS.maxAtomic,
        outputAtomic: '0',
      }),
    { code: CONTROL_CODES.LIMIT },
  );
});

void test('v2 public catalogs accept explicit per-million fields and reject old or mixed price representations', async () => {
  const run = await controlFixture();
  const listing = run.catalog.models[0]!;
  const pricing = {
    network: listing.pricing.network,
    asset: listing.pricing.asset,
    unit: 'million-tokens',
    ...prices(),
  };
  const catalog = (value: unknown) => ({
    ...run.catalog,
    models: [{ ...listing, pricing: value }],
  });
  assert.deepEqual(parsePublicV2(catalog(pricing)), catalog(pricing));
  for (const value of [
    { ...pricing, unit: 'token' },
    {
      network: pricing.network,
      asset: pricing.asset,
      unit: 'token',
      inputAtomic: '1',
      outputAtomic: '2',
    },
    { ...pricing, inputAtomic: '1' },
    { ...pricing, inputAtomicPerMtok: '01' },
  ])
    assert.throws(() => parsePublicV2(catalog(value)), {
      code: CONTROL_CODES.INVALID,
    });
});

void test('v2 control request ceilings reject ambiguous per-token keys before hashing', async () => {
  const run = await controlFixture();
  const query = (value: unknown) => ({
    ...run.request,
    params: { ...run.request.params, priceCeilings: value },
  });
  assert.deepEqual(parseControlQuery(query(prices())), query(prices()));
  assert.throws(
    () => parseControlQuery(query({ inputAtomic: '1', outputAtomic: '2' })),
    { code: CONTROL_CODES.INVALID },
  );
  assert.throws(
    () => parseControlQuery(query({ ...prices(), outputAtomic: '2' })),
    { code: CONTROL_CODES.INVALID },
  );
});

void test('v2 private offer parsing rejects the historical per-token shape instead of converting it', async () => {
  const { createControlQuote } = await import('@gyblos/core/control-quotes');
  const run = await controlFixture();
  const quote = await createControlQuote(
    run.request,
    run.context,
    run.ownerSigner,
  );
  assert.throws(
    () =>
      parseOfferV2({
        ...quote.offer,
        prices: { inputAtomic: '1', outputAtomic: '2' },
      }),
    { code: CONTROL_CODES.INVALID },
  );
});
