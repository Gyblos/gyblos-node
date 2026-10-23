// Registers facilitator observer cases: SDK success, pending, verification and policy outcomes are
// recorded distinctly, and a faulty observer cannot alter or delay the settlement response.
import assert from 'node:assert/strict';
import test from 'node:test';

import { signature } from '@solana/kit';
import {
  ErrSettlementPending,
  SettlementConfirmationTimeoutError,
} from '@x402/svm/upto/facilitator';

import {
  DEVNET,
  FACILITATOR_DIAGNOSTIC_CODES,
  FACILITATOR_STAGES,
  PUBLIC_CALL_OPERATIONS,
} from '@gyblos/payments-x402/constants';

import {
  DIAGNOSTIC_CANARY,
  DIAGNOSTIC_SIGNATURE,
  diagnosticUntil,
  withDiagnosticHost,
} from './facilitator-diagnostic-fixture.js';

export function registerFacilitatorObserverCases() {
  void test(
    'facilitator records received, SDK success and local finish with one attempt',
    { timeout: 10000 },
    async () => {
      await withDiagnosticHost({}, async ({ call, records, calls }) => {
        const response = await call();
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.success, true);
        await diagnosticUntil(() =>
          records.some(
            (row) => row.stage === FACILITATOR_STAGES.RESPONSE_FINISHED,
          ),
        );
        assert.deepEqual(
          records.map((row) => row.stage),
          [
            FACILITATOR_STAGES.RECEIVED,
            FACILITATOR_STAGES.SDK_STARTED,
            FACILITATOR_STAGES.SDK_RESULT,
            FACILITATOR_STAGES.RESPONSE_FINISHED,
          ],
        );
        assert.equal(new Set(records.map((row) => row.attemptId)).size, 1);
        assert.deepEqual(
          records.map((row) => row.sequence),
          [1, 2, 3, 4],
        );
        assert.equal(records[2]!.sdkSuccess, true);
        assert.equal(records[2]!.transaction, DIAGNOSTIC_SIGNATURE);
        assert.equal(records[3]!.httpStatus, 200);
        assert.equal(calls.settle, 1);
      });
    },
  );
  void test(
    'facilitator keeps SDK pending failure inside HTTP200 without retrying',
    { timeout: 10000 },
    async () => {
      const pending = {
        success: false,
        network: DEVNET,
        transaction: DIAGNOSTIC_SIGNATURE,
        errorReason: ErrSettlementPending,
      };
      await withDiagnosticHost(
        { settle: async () => pending },
        async ({ call, records, calls }) => {
          const response = await call();
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), pending);
          const result = records.find(
            (row) => row.stage === FACILITATOR_STAGES.SDK_RESULT,
          )!;
          assert.equal(result.sdkSuccess, false);
          assert.equal(
            result.code,
            FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING,
          );
          assert.equal(result.transaction, DIAGNOSTIC_SIGNATURE);
          assert.equal(calls.settle, 1);
        },
      );
    },
  );
  void test(
    'facilitator verification rejection differs from SDK exception and policy rejection',
    { timeout: 10000 },
    async () => {
      await withDiagnosticHost(
        {
          verify: async () => ({
            isValid: false,
            invalidReason: DIAGNOSTIC_CANARY,
          }),
        },
        async ({ call, records, calls }) => {
          const response = await call(PUBLIC_CALL_OPERATIONS.VERIFY);
          assert.equal(response.status, 200);
          await response.json();
          assert.equal(
            records.find((row) => row.stage === FACILITATOR_STAGES.SDK_RESULT)
              ?.code,
            FACILITATOR_DIAGNOSTIC_CODES.SDK_REJECTED,
          );
          assert.ok(!JSON.stringify(records).includes(DIAGNOSTIC_CANARY));
          assert.equal(calls.verify, 1);
          assert.equal(calls.settle, 0);
        },
      );
    },
  );
  void test(
    'facilitator policy rejection has no SDK-start event or settlement',
    { timeout: 10000 },
    async () => {
      await withDiagnosticHost({}, async ({ call, records, calls }) => {
        const response = await call(PUBLIC_CALL_OPERATIONS.SETTLE, {});
        assert.equal(response.status, 400);
        await response.json();
        assert.ok(
          records.some(
            (row) => row.stage === FACILITATOR_STAGES.POLICY_REJECTED,
          ),
        );
        assert.ok(
          !records.some((row) => row.stage === FACILITATOR_STAGES.SDK_STARTED),
        );
        assert.equal(calls.settle, 0);
      });
    },
  );
  void test(
    'facilitator typed confirmation exception retains only a public signature hint',
    { timeout: 10000 },
    async () => {
      let simulatedEffects = 0;
      await withDiagnosticHost(
        {
          settle: async () => {
            simulatedEffects++;
            throw new SettlementConfirmationTimeoutError(
              signature(DIAGNOSTIC_SIGNATURE),
            );
          },
        },
        async ({ call, records, calls }) => {
          const response = await call();
          assert.equal(response.status, 500);
          await response.json();
          const error = records.find(
            (row) => row.stage === FACILITATOR_STAGES.SDK_EXCEPTION,
          )!;
          assert.equal(
            error.code,
            FACILITATOR_DIAGNOSTIC_CODES.CONFIRMATION_UNKNOWN,
          );
          assert.equal(error.transaction, DIAGNOSTIC_SIGNATURE);
          assert.equal(simulatedEffects, 1);
          assert.equal(calls.settle, 1);
          assert.ok(!records.some((row) => row.sdkSuccess === true));
        },
      );
    },
  );
  for (const behavior of ['throws', 'rejects', 'stalls'] as const)
    void test(
      `diagnostic observer ${behavior} cannot replace or delay settlement response`,
      { timeout: 10000 },
      async () => {
        await withDiagnosticHost(
          {
            onDiagnostic() {
              if (behavior === 'throws') throw new Error(DIAGNOSTIC_CANARY);
              if (behavior === 'rejects')
                return Promise.reject(new Error(DIAGNOSTIC_CANARY));
              return new Promise<void>(() => {});
            },
          },
          async ({ call, calls }) => {
            const response = await call();
            assert.equal(response.status, 200);
            assert.equal((await response.json()).success, true);
            assert.equal(calls.settle, 1);
          },
        );
      },
    );
}
