// Per-case inference assertions: engine interruption charges nothing; overcharge, undercharge and
// normal cases must match their expected billed tokens, charge and anomaly label.
import assert from 'node:assert/strict';

import { INFERENCE_CASES } from '@gyblos/buyer/constants';
import type { Measurement } from '@gyblos/buyer/measurements';
import { HTTP_STATUS } from '@gyblos/config';
import { CHARGE_ANOMALIES, OFFER_ID } from '@gyblos/core/constants';
import type { observeInferenceResponse } from '@gyblos/core/inference-observation';
import { charge } from '@gyblos/core/metering';
import { MODEL } from '@gyblos/engine-ollama/model';

import { type InferenceCaseName } from '../../constants.js';
import type { InferenceTrace } from '../../types.js';

interface CaseAssertion {
  caseName: InferenceCaseName;
  status: number;
  observation: ReturnType<typeof observeInferenceResponse>;
  measurement: Measurement;
  actual: bigint;
  trace: InferenceTrace;
}

export function assertInferenceCase({
  caseName,
  status,
  observation,
  measurement,
  actual,
  trace,
}: CaseAssertion) {
  const { body, failed, engineTokens, delivered, comparison } = observation;
  if (caseName === INFERENCE_CASES.ENGINE_INTERRUPTED) {
    assert.equal(failed, true);
    assert.equal(status, HTTP_STATUS.badGateway);
    assert.equal(actual, 0n);
    assert.equal(measurement.anomaly, CHARGE_ANOMALIES.FAILED);
    assert.ok(trace.firstFragmentAt && trace.stoppedAt);
    assert.equal(measurement.delivered, false);
  } else {
    assert.equal(failed, false);
    assert.equal(body.offer, OFFER_ID);
    assert.equal(body.model, MODEL.name);
    assert.equal(body.digest, MODEL.digest);
    assert.ok(delivered && engineTokens && comparison?.withinTolerance);
    assert.equal(actual, charge(body.billedTokens!));
    if (caseName === INFERENCE_CASES.OVERCHARGE) {
      assert.ok(body.billedTokens!.output > engineTokens.output);
      assert.equal(measurement.anomaly, CHARGE_ANOMALIES.OVERCHARGE);
    } else if (caseName === INFERENCE_CASES.UNDERCHARGE) {
      assert.equal(body.billedTokens!.input, engineTokens.input);
      assert.ok(body.billedTokens!.output < engineTokens.output);
      assert.ok(actual > 0n);
      assert.ok(
        actual <
          BigInt(measurement.expectedAtomic) -
            BigInt(measurement.allowanceAtomic),
      );
      assert.ok(BigInt(measurement.differenceAtomic) < 0n);
      assert.equal(measurement.anomaly, CHARGE_ANOMALIES.UNDERCHARGE);
    } else {
      assert.deepEqual(body.billedTokens, engineTokens);
      assert.equal(actual, charge(engineTokens));
      assert.equal(measurement.anomaly, CHARGE_ANOMALIES.NONE);
    }
  }
}
