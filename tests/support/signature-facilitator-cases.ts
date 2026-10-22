// Owns offline signature facilitator cases regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { signature } from '@solana/kit';
import { SettleError } from '@x402/core/types';
import {
  ChannelOpenConfirmationError,
  ErrSettlementPending,
  SettlementConfirmationTimeoutError,
} from '@x402/svm/upto/facilitator';

import {
  DEVNET,
  FACILITATOR_DIAGNOSTIC_CODES,
  FACILITATOR_STAGES,
  PUBLIC_CALL_OPERATIONS,
} from '@gyblos/payments-x402/constants';
import type { FacilitatorDiagnosticRecord } from '@gyblos/payments-x402/facilitator-diagnostics';
import { PRIVATE_LOG_STATES } from '@gyblos/runtime/constants';

import {
  createFacilitatorObserver,
  createPrivateLog,
  DIAGNOSTIC_CANARY,
  DIAGNOSTIC_SIGNATURE,
  diagnosticDirectory,
  diagnosticRows,
  rm,
  withDiagnosticHost,
} from './facilitator-diagnostic-fixture.js';
import { PRIVATE_LOG_PLATFORM_SKIP } from './private-log-fixture.js';

const INVALID_SIGNATURES = [
  '0'.repeat(64),
  'O'.repeat(88),
  DIAGNOSTIC_CANARY.padEnd(64, '0'),
];
const TYPED_ERRORS = [
  {
    name: 'channel confirmation',
    field: 'signature',
    code: FACILITATOR_DIAGNOSTIC_CODES.CONFIRMATION_UNKNOWN,
    create: () =>
      new ChannelOpenConfirmationError(
        DIAGNOSTIC_SIGNATURE,
        new Error(DIAGNOSTIC_CANARY),
      ),
  },
  {
    name: 'settlement confirmation',
    field: 'signature',
    code: FACILITATOR_DIAGNOSTIC_CODES.CONFIRMATION_UNKNOWN,
    create: () =>
      new SettlementConfirmationTimeoutError(signature(DIAGNOSTIC_SIGNATURE)),
  },
  {
    name: 'pending settlement',
    field: 'transaction',
    code: FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING,
    create: () =>
      new SettleError(500, {
        success: false,
        transaction: DIAGNOSTIC_SIGNATURE,
        network: DEVNET,
        errorReason: ErrSettlementPending,
        errorMessage: DIAGNOSTIC_CANARY,
      }),
  },
];

function observer() {
  const records: FacilitatorDiagnosticRecord[] = [];
  const attempt = createFacilitatorObserver({
    onDiagnostic(record) {
      records.push(record);
    },
  })(PUBLIC_CALL_OPERATIONS.SETTLE);
  return { attempt, records };
}

export function registerSignatureFacilitatorCases() {
  void test('signature hints: malformed result metadata cannot throw or erase canonical SDK observations', () => {
    const { attempt, records } = observer();
    for (const transaction of [
      ...INVALID_SIGNATURES,
      '',
      '1'.repeat(63),
      '1'.repeat(89),
      null,
      {},
      true,
    ]) {
      assert.doesNotThrow(() =>
        attempt.result({
          success: false,
          transaction,
          errorReason: ErrSettlementPending,
        }),
      );
      const row = records.at(-1)!;
      assert.equal(row.stage, FACILITATOR_STAGES.SDK_RESULT);
      assert.equal(row.sdkSuccess, false);
      assert.equal(row.code, FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING);
      assert.equal(row.transaction, undefined);
    }
    attempt.result({ success: true, transaction: DIAGNOSTIC_SIGNATURE });
    assert.equal(records.at(-1)?.transaction, DIAGNOSTIC_SIGNATURE);
    assert.equal(records.at(-1)?.sdkSuccess, true);
    assert.ok(!JSON.stringify(records).includes(DIAGNOSTIC_CANARY));
  });
  for (const success of [true, false])
    void test(
      `signature hints: facilitator preserves SDK HTTP200 and body with malformed transaction: success=${success}`,
      { timeout: 10000 },
      async () => {
        for (const transaction of INVALID_SIGNATURES) {
          let simulatedEffects = 0;
          const result = {
            success,
            network: DEVNET,
            transaction,
            ...(success ? {} : { errorReason: ErrSettlementPending }),
          };
          await withDiagnosticHost(
            {
              settle: async () => {
                simulatedEffects++;
                return result;
              },
            },
            async ({ call, calls, records }) => {
              const response = await call();
              const body: unknown = await response.json();
              assert.equal(calls.settle, 1);
              assert.equal(simulatedEffects, 1);
              assert.equal(calls.network, 0);
              assert.equal(response.status, 200);
              assert.deepEqual(body, result);
              const row = records.find(
                (record) => record.stage === FACILITATOR_STAGES.SDK_RESULT,
              )!;
              assert.ok(row);
              assert.equal(row.sdkSuccess, success);
              assert.equal(row.transaction, undefined);
              assert.equal(
                row.code,
                success
                  ? undefined
                  : FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING,
              );
              assert.ok(
                !records.some(
                  (record) =>
                    record.stage === FACILITATOR_STAGES.RESPONSE_ERROR,
                ),
              );
              assert.ok(!JSON.stringify(records).includes(transaction));
            },
          );
        }
      },
    );
  for (const scenario of TYPED_ERRORS)
    void test(`signature hints: malformed ${scenario.name} hint preserves the typed error category`, () => {
      const { attempt, records } = observer();
      for (const invalid of INVALID_SIGNATURES) {
        const error = scenario.create();
        Object.defineProperty(error, scenario.field, { value: invalid });
        assert.doesNotThrow(() => attempt.exception(error));
        assert.equal(records.at(-1)?.stage, FACILITATOR_STAGES.SDK_EXCEPTION);
        assert.equal(records.at(-1)?.code, scenario.code);
        assert.equal(records.at(-1)?.transaction, undefined);
      }
      attempt.exception(scenario.create());
      assert.equal(records.at(-1)?.transaction, DIAGNOSTIC_SIGNATURE);
      assert.equal(records.at(-1)?.code, scenario.code);
      assert.ok(!JSON.stringify(records).includes(DIAGNOSTIC_CANARY));
    });
  void test(
    'signature hints: malformed SDK hints are omitted from persistent records without losing the result',
    { timeout: 10000, skip: PRIVATE_LOG_PLATFORM_SKIP },
    async () => {
      const directory = await diagnosticDirectory();
      const transaction = INVALID_SIGNATURES[2]!;
      try {
        const log = await createPrivateLog(join(directory, 'log'));
        try {
          await withDiagnosticHost(
            {
              onDiagnostic: log.write,
              settle: async () => ({
                success: false,
                network: DEVNET,
                transaction,
                errorReason: ErrSettlementPending,
              }),
            },
            async ({ call, calls }) => {
              const response = await call();
              await response.json();
              assert.equal(calls.settle, 1);
              assert.equal(response.status, 200);
            },
          );
        } finally {
          await log.close();
        }
        assert.equal(log.health().state, PRIVATE_LOG_STATES.CLOSED);
        const rows = await diagnosticRows(log.path!);
        assert.ok(
          rows.some(
            (row) =>
              row.stage === FACILITATOR_STAGES.SDK_RESULT &&
              row.code === FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING,
          ),
        );
        assert.ok(rows.every((row) => row.transaction === undefined));
        const contents = await readFile(log.path!, 'utf8');
        assert.ok(!contents.includes(transaction));
        assert.ok(!contents.includes(DIAGNOSTIC_CANARY));
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
}
