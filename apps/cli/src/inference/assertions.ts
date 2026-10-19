import assert from 'node:assert/strict';

import type { observeInferenceResponse } from '@gyblos/application/inference-observation';
import { charge, OFFER_ID } from '@gyblos/application/metering';
import { HTTP_STATUS } from '@gyblos/config';
import type { Measurement } from '@gyblos/gate/measurements';
import type { InferenceTrace } from '@gyblos/gate/types';
import { MODEL } from '@gyblos/inference-ollama/index';

interface CaseAssertion {
  caseName: string;
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
  if (caseName === 'engine-interrupted') {
    assert.equal(failed, true);
    assert.equal(status, HTTP_STATUS.badGateway);
    assert.equal(actual, 0n);
    assert.equal(measurement.anomaly, 'failed');
    assert.ok(trace.firstFragmentAt && trace.stoppedAt);
    assert.equal(measurement.delivered, false);
  } else {
    assert.equal(failed, false);
    assert.equal(body.offer, OFFER_ID);
    assert.equal(body.model, MODEL.name);
    assert.equal(body.digest, MODEL.digest);
    assert.ok(delivered && engineTokens && comparison?.withinTolerance);
    assert.equal(actual, charge(body.billedTokens!));
    if (caseName === 'overcharge') {
      assert.ok(body.billedTokens!.output > engineTokens.output);
      assert.equal(measurement.anomaly, 'overcharge');
    } else if (caseName === 'undercharge') {
      assert.equal(body.billedTokens!.input, engineTokens.input);
      assert.ok(body.billedTokens!.output < engineTokens.output);
      assert.ok(actual > 0n);
      assert.ok(
        actual <
          BigInt(measurement.expectedAtomic) -
            BigInt(measurement.allowanceAtomic),
      );
      assert.ok(BigInt(measurement.differenceAtomic) < 0n);
      assert.equal(measurement.anomaly, 'undercharge');
    } else {
      assert.deepEqual(body.billedTokens, engineTokens);
      assert.equal(actual, charge(engineTokens));
      assert.equal(measurement.anomaly, 'none');
    }
  }
}
