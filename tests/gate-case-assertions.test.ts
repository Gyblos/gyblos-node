import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INFERENCE_CASES,
  type InferenceCaseName,
} from '@gyblos/gate/constants';

import { assertInferenceCase } from '../apps/cli/src/inference/assertions.js';
import { observeInferenceResponse } from '../packages/application/src/inference-observation.js';
import {
  assessCharge,
  charge,
  OFFER_ID,
} from '../packages/application/src/metering.js';
import { measurementRow } from '../packages/gate/src/measurements.js';
import { MODEL } from '../packages/inference-ollama/src/index.js';

function fixture(
  options: {
    name?: InferenceCaseName;
    billedInput?: number;
    billedOutput?: number;
    status?: number;
    reason?: string;
    engineInput?: number;
  } = {},
) {
  const caseName = options.name ?? INFERENCE_CASES.UNDERCHARGE;
  const status = options.status ?? 200;
  const billed = {
    input: options.billedInput ?? 24,
    output: options.billedOutput ?? 66,
  };
  const observation = observeInferenceResponse({
    status,
    body: {
      requestId: 'request',
      offer: OFFER_ID,
      model: MODEL.name,
      digest: MODEL.digest,
      content: 'Synthetic test output',
      done: true,
      doneReason: options.reason ?? 'stop',
      billedTokens: billed,
      usage: {
        prompt_eval_count: options.engineInput ?? 24,
        eval_count: 110,
        total_duration: 1,
        load_duration: 1,
        prompt_eval_duration: 1,
        eval_duration: 1,
      },
    },
    expected: {
      requestId: 'request',
      offer: OFFER_ID,
      model: MODEL.name,
      digest: MODEL.digest,
    },
    inputTokens: options.engineInput ?? 24,
    countOutput: () => (status === 200 ? 109 : 0),
  });
  const actual = status === 200 ? charge(billed) : 0n;
  const measurement = measurementRow(
    {
      requestId: 'request',
      seller: 'seller',
      offer: OFFER_ID,
      channelId: 'channel',
      depositSignature: 'deposit',
      claimSignature: 'claim',
      ceilingAtomic: '560',
      chargedAtomic: actual.toString(),
      ...assessCharge(
        actual,
        observation.recounted,
        observation.delivered,
        observation.failed,
      ),
      engineTokens: observation.engineTokens,
      billedTokens: observation.body.billedTokens ?? null,
      recountedTokens: observation.recounted,
      countComparison: observation.comparison,
      latencyMs: 1,
      delivered: observation.delivered,
      responseText: observation.text,
    },
    new Uint8Array(32),
  );
  const trace = {
    channelId: 'channel',
    depositConfirmedAt: '2026-01-01T00:00:00Z',
    engineStartedAt: '2026-01-01T00:00:01Z',
    during: {
      slot: 1,
      buyer: '0',
      seller: '0',
      escrow: '560',
      buyerLamports: '0',
    },
    firstFragmentAt: '2026-01-01T00:00:02Z',
    stoppedAt: '2026-01-01T00:00:03Z',
  };
  return { caseName, status, observation, measurement, actual, trace };
}

test('gate accepts a delivered positive undercharge beyond independently recounted tolerance', () => {
  const context = fixture();
  assert.equal(context.actual, 156n);
  assert.equal(context.measurement.expectedAtomic, '242');
  assert.equal(context.measurement.allowanceAtomic, '8');
  assert.equal(context.measurement.anomaly, 'undercharge');
  assert.doesNotThrow(() => assertInferenceCase(context));
});

test('undercharge gate rejects honest billing and discounts inside tolerance', () => {
  for (const billedOutput of [110, 107])
    assert.throws(() => assertInferenceCase(fixture({ billedOutput })));
});

test('undercharge gate requires complete successful delivery', () => {
  assert.throws(() => assertInferenceCase(fixture({ status: 502 })));
  assert.throws(() => assertInferenceCase(fixture({ reason: 'length' })));
});

test('undercharge gate cannot discount the input tokens', () => {
  assert.throws(() => assertInferenceCase(fixture({ billedInput: 23 })));
});

test('a forged undercharge annotation cannot bypass the strict financial threshold', () => {
  const context = fixture({ billedOutput: 107 });
  context.measurement.anomaly = 'undercharge';
  assert.throws(() => assertInferenceCase(context));
});

test('case assertion extraction retains all original honest overcharge and interruption acceptance', () => {
  for (const name of [
    INFERENCE_CASES.HONEST_1,
    INFERENCE_CASES.HONEST_2,
    INFERENCE_CASES.HONEST_3,
  ])
    assert.doesNotThrow(() =>
      assertInferenceCase(fixture({ name, billedOutput: 110 })),
    );
  assert.doesNotThrow(() =>
    assertInferenceCase(
      fixture({ name: INFERENCE_CASES.OVERCHARGE, billedOutput: 154 }),
    ),
  );
  assert.doesNotThrow(() =>
    assertInferenceCase(
      fixture({ name: INFERENCE_CASES.ENGINE_INTERRUPTED, status: 502 }),
    ),
  );
});

test('discounted billing cannot pass as an ordinary honest case', () => {
  assert.throws(() =>
    assertInferenceCase(fixture({ name: INFERENCE_CASES.HONEST_1 })),
  );
});

test('undercharge acceptance rejects a zero charge even when its annotation and counts agree', () => {
  const context = fixture({ engineInput: 0, billedInput: 0, billedOutput: 0 });
  assert.equal(context.actual, 0n);
  assert.equal(context.measurement.anomaly, 'undercharge');
  assert.throws(() => assertInferenceCase(context));
});

test('strict undercharge acceptance rejects equality at the allowance boundary', () => {
  const context = fixture({ billedOutput: 105 });
  assert.equal(
    context.actual,
    BigInt(context.measurement.expectedAtomic) -
      BigInt(context.measurement.allowanceAtomic),
  );
  assert.equal(context.measurement.anomaly, 'none');
  context.measurement.anomaly = 'undercharge';
  assert.throws(() => assertInferenceCase(context));
});
