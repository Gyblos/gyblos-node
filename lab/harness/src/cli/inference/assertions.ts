import assert from 'node:assert/strict';

import { CHARGE_ANOMALIES } from '@gyblos/application/constants';
import type { observeInferenceResponse } from '@gyblos/application/inference-observation';
import { charge, OFFER_ID } from '@gyblos/application/metering';
import { HTTP_STATUS } from '@gyblos/config';
import { MODEL } from '@gyblos/inference-ollama/index';
import {
  INFERENCE_CASES,
  type InferenceCaseName,
} from '@gyblos/lab-harness/constants';
import type { InferenceTrace } from '@gyblos/lab-harness/types';
import type { Measurement } from '@gyblos/node/measurements';

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
