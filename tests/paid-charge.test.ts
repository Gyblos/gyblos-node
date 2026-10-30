// Prices a paid execution from recounted tokens and bounds its output by the deposited ceiling.
// Pure arithmetic over synthetic requests; no engine, tokenizer or chain.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  paidCharge,
  paidOutputAllowance,
  type PaidUsage,
} from '@gyblos/core/paid-charge';
import { chargeV2 } from '@gyblos/core/pricing-v2';
import type { PaidExecutionRequest } from '@gyblos/protocol/paid-execution';

import { request } from './support/paid-fixture';

// One atomic unit per input token and two per output token.
const PER_TOKEN = {
  inputAtomicPerMtok: '1000000',
  outputAtomicPerMtok: '2000000',
};

function priced(
  paid: PaidExecutionRequest,
  prices: { inputAtomicPerMtok: string; outputAtomicPerMtok: string },
  maxAtomic: string,
  maxTokens = 1000,
  contextTokens = 100_000,
): PaidExecutionRequest {
  const offer = paid.quote.offer;
  return {
    ...paid,
    quote: {
      ...paid.quote,
      offer: {
        ...offer,
        prices,
        maxAtomic,
        maxTokens,
        model: { ...offer.model, contextTokens },
      },
    },
    input: { ...paid.input, maxTokens },
    payment: { ...paid.payment, maxAtomic },
  };
}

void test('the output allowance is what the ceiling still pays for after the input', async () => {
  const paid = priced(await request(), PER_TOKEN, '10');
  assert.equal(paidOutputAllowance(paid, 4), 3);
  assert.equal(paidOutputAllowance(paid, 8), 1);
  // The input with one output token must fit, or nothing is deposited.
  assert.equal(paidOutputAllowance(paid, 9), null);
  assert.equal(paidOutputAllowance(paid, 10), null);
});

void test('the allowance never exceeds the requested tokens or the model context', async () => {
  const base = await request();
  assert.equal(paidOutputAllowance(priced(base, PER_TOKEN, '1000', 5), 4), 5);
  const context = priced(base, PER_TOKEN, '1000', 50, 10);
  assert.equal(paidOutputAllowance(context, 4), 6);
  assert.equal(paidOutputAllowance(context, 10), null);
  // Free output is bounded only by the requested tokens.
  const freeOutput = priced(
    base,
    { inputAtomicPerMtok: '1000000', outputAtomicPerMtok: '0' },
    '10',
    7,
  );
  assert.equal(paidOutputAllowance(freeOutput, 9), 7);
});

void test('the allowance is the largest output whose rounded charge stays within the ceiling', async () => {
  const base = await request();
  for (const [inputPrice, outputPrice, ceiling, input] of [
    ['1', '2', '1', 3],
    ['7', '13', '3', 5],
    ['999999', '1000001', '9', 2],
    ['0', '3', '1', 0],
  ] as const) {
    const prices = {
      inputAtomicPerMtok: inputPrice,
      outputAtomicPerMtok: outputPrice,
    };
    const paid = priced(base, prices, ceiling, 10_000_000, 10_000_000);
    const allowance = paidOutputAllowance(paid, input);
    assert.ok(allowance !== null && allowance > 0);
    const limit = BigInt(ceiling);
    assert.ok(chargeV2({ input, output: allowance }, prices) <= limit);
    assert.ok(chargeV2({ input, output: allowance + 1 }, prices) > limit);
  }
});

void test('a charge prices the delivered tokens at the quote and is zero without delivery', async () => {
  const paid = priced(await request(), PER_TOKEN, '10');
  assert.deepEqual(
    paidCharge(paid, { inputTokens: 4, outputTokens: 3 }, true),
    {
      inputTokens: 4,
      outputTokens: 3,
      chargedAtomic: '10',
    },
  );
  assert.deepEqual(
    paidCharge(paid, { inputTokens: 4, outputTokens: 3 }, false),
    {
      inputTokens: 4,
      outputTokens: 0,
      chargedAtomic: '0',
    },
  );
  // A count beyond the allowance is never charged above the deposited ceiling.
  assert.equal(
    paidCharge(paid, { inputTokens: 4, outputTokens: 30 }, true).chargedAtomic,
    '10',
  );
});

void test('counts that are not whole non-negative numbers are refused', async () => {
  const paid = priced(await request(), PER_TOKEN, '10');
  for (const tokens of [-1, 1.5, Number.NaN]) {
    assert.throws(() =>
      paidCharge(paid, { inputTokens: tokens, outputTokens: 1 }, true),
    );
    assert.throws(() =>
      paidCharge(paid, { inputTokens: 1, outputTokens: tokens }, true),
    );
    assert.throws(() => paidOutputAllowance(paid, tokens));
  }
});

void test('the golden vector charges are the quote prices applied to the recounted tokens', async () => {
  const vectors: {
    request: PaidExecutionRequest;
    streams: Record<
      string,
      { event: { response?: Record<string, unknown> } }[]
    >;
  } = JSON.parse(
    await readFile(
      fileURLToPath(
        import.meta.resolve('@gyblos/protocol/vectors/paid-execution-v1.json'),
      ),
      'utf8',
    ),
  );
  let checked = 0;
  for (const events of Object.values(vectors.streams)) {
    const response = events.at(-1)?.event.response;
    const charge = response?.charge;
    if (!charge || typeof charge !== 'object') continue;
    const { inputTokens, outputTokens } = charge as PaidUsage;
    assert.deepEqual(
      paidCharge(
        vectors.request,
        { inputTokens, outputTokens },
        outputTokens > 0,
      ),
      charge,
    );
    checked++;
  }
  assert.equal(checked, 4);
});

void test('no output charges nothing, and huge counts or prices stop at the ceiling', async () => {
  const paid = priced(await request(), PER_TOKEN, '10');
  assert.equal(
    paidCharge(paid, { inputTokens: 4, outputTokens: 0 }, true).chargedAtomic,
    '0',
  );
  const huge = priced(
    paid,
    {
      inputAtomicPerMtok: '18446744073709551615',
      outputAtomicPerMtok: '18446744073709551615',
    },
    '10',
  );
  assert.equal(
    paidCharge(
      huge,
      { inputTokens: 20_000_000, outputTokens: 20_000_000 },
      true,
    ).chargedAtomic,
    '10',
  );
  assert.equal(paidOutputAllowance(huge, 1), null);
});

void test('free prices allow the requested tokens and charge nothing', async () => {
  const zero = { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' };
  const paid = priced(await request(), zero, '10', 7);
  assert.equal(paidOutputAllowance(paid, 1_000), 7);
  assert.equal(
    paidCharge(paid, { inputTokens: 5, outputTokens: 5 }, true).chargedAtomic,
    '0',
  );
});

void test('the requested tokens bound the allowance below the quoted maximum', async () => {
  const paid = priced(await request(), PER_TOKEN, '1000', 50);
  const fewer = { ...paid, input: { ...paid.input, maxTokens: 3 } };
  assert.equal(paidOutputAllowance(fewer, 4), 3);
});
