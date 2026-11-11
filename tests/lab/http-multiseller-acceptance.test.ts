// Full two-seller product acceptance uses native loopback Iroh and simulated services, never a real chain.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HTTP_MULTI_CASES } from '../support/http-multiseller-constants';
import { httpMultisellerScenario } from '../support/http-multiseller-scenarios';
import { NATIVE_CAPABILITY } from '../support/native-runtime';

for (const kind of Object.values(HTTP_MULTI_CASES)) {
  void test(
    `product HTTP through discovery and Iroh: ${kind}`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async () => {
      const report = await httpMultisellerScenario(kind);
      assert.ok(report, 'a complete scenario must produce verified evidence');
      assert.equal(report.nativeIroh, true);
      assert.equal(report.externalCalls, 0);
      assert.equal(report.forbiddenRpcMethods, 0);
      assert.ok(report.registryReads >= 2);
      assert.ok(report.generations >= report.answers);
      assert.ok(report.deposits >= 1 && report.deposits <= 2);
    },
  );
}
