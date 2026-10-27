// Full streaming acceptance is synthetic-only: real in-process index, native Iroh and product HTTP.
import assert from 'node:assert/strict';
import test from 'node:test';

import { NATIVE_TEST_OPTIONS } from '../support/native-runtime.js';

void test(
  'native free streaming proves early HTTP delivery and cancellation reaches the seller engine',
  NATIVE_TEST_OPTIONS,
  async () => {
    const { runFreeStreamAcceptance } =
      await import('@gyblos/lab-harness/acceptance/free-stream');
    const report = await runFreeStreamAcceptance();
    assert.equal(report.ok, true);
    assert.equal(report.nativeIroh, true);
    assert.equal(report.paymentsEnabled, false);
    assert.equal(report.answers, 1);
    assert.equal(report.cancellations, 1);
    assert.equal(report.noRetry, true);
    assert.equal(report.queryEngineAttempts, 0);
    assert.doesNotMatch(
      JSON.stringify(report),
      /synthetic content|signature|nodeId|owner|prompt|address|https?:|\.local|\/tmp\//i,
    );
  },
);
