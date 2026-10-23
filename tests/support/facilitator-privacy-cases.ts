// Registers facilitator diagnostic privacy cases: projections drop arbitrary fields, messages, stacks
// and hostile metadata, and never invent a signature hint.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ChannelOpenConfirmationError,
  ErrSettlementPending,
  SettlementSimulationError,
} from '@x402/svm/upto/facilitator';

import {
  FACILITATOR_DIAGNOSTIC_CODES,
  FACILITATOR_PHASES,
  FACILITATOR_STAGES,
  PUBLIC_CALL_OPERATIONS,
} from '@gyblos/payments-x402/constants';
import type { FacilitatorDiagnosticRecord } from '@gyblos/payments-x402/facilitator-diagnostics';

import {
  createFacilitatorObserver,
  DIAGNOSTIC_CANARY,
  DIAGNOSTIC_CHANNEL,
  DIAGNOSTIC_SIGNATURE,
} from './facilitator-diagnostic-fixture.js';

export function registerFacilitatorPrivacyCases() {
  void test('facilitator projection omits arbitrary fields and never coerces hostile metadata', () => {
    const records: FacilitatorDiagnosticRecord[] = [];
    const begin = createFacilitatorObserver({
      onDiagnostic(record) {
        records.push(record);
      },
    });
    const attempt = begin(PUBLIC_CALL_OPERATIONS.SETTLE);
    attempt.identify(
      {
        payload: {
          type: DIAGNOSTIC_CANARY,
          channelId: 'https://private.invalid/?api_key=' + DIAGNOSTIC_CANARY,
        },
      },
      { amount: '9'.repeat(10000) },
    );
    attempt.result({
      success: false,
      transaction: DIAGNOSTIC_CANARY,
      errorReason: DIAGNOSTIC_CANARY,
      errorMessage: DIAGNOSTIC_CANARY,
      prompt: DIAGNOSTIC_CANARY,
      payload: DIAGNOSTIC_CANARY,
    });
    const result = records.at(-1)!;
    assert.equal(result.phase, FACILITATOR_PHASES.UNKNOWN);
    assert.equal(result.channelId, undefined);
    assert.equal(result.amountAtomic, undefined);
    assert.equal(result.transaction, undefined);
    assert.equal(result.code, FACILITATOR_DIAGNOSTIC_CODES.SDK_REJECTED);
    assert.ok(!JSON.stringify(records).includes(DIAGNOSTIC_CANARY));
    for (const amount of ['-1', '01', '1.2', '10001', 148, null, {}]) {
      attempt.identify(
        {
          payload: {
            type: FACILITATOR_PHASES.CLAIM,
            channelId: DIAGNOSTIC_CHANNEL,
          },
        },
        { amount },
      );
      attempt.record(FACILITATOR_STAGES.SDK_STARTED);
      assert.equal(records.at(-1)?.amountAtomic, undefined);
    }
  });
  void test('facilitator projection reads reason once and returns the canonical member', () => {
    const records: FacilitatorDiagnosticRecord[] = [];
    const attempt = createFacilitatorObserver({
      onDiagnostic(record) {
        records.push(record);
      },
    })(PUBLIC_CALL_OPERATIONS.SETTLE);
    let reasonReads = 0;
    attempt.result({
      success: false,
      transaction: DIAGNOSTIC_SIGNATURE,
      get errorReason() {
        return ++reasonReads === 1 ? ErrSettlementPending : DIAGNOSTIC_CANARY;
      },
      get errorMessage() {
        throw new Error(DIAGNOSTIC_CANARY);
      },
      toJSON() {
        throw new Error(DIAGNOSTIC_CANARY);
      },
    });
    assert.equal(reasonReads, 1);
    assert.equal(
      records.at(-1)?.code,
      FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING,
    );
    assert.ok(!JSON.stringify(records).includes(DIAGNOSTIC_CANARY));
    assert.ok(records.every(Object.isFrozen));
  });
  void test('facilitator exception projection ignores message, stack, cause and hostile prototypes', () => {
    const records: FacilitatorDiagnosticRecord[] = [];
    const attempt = createFacilitatorObserver({
      onDiagnostic(record) {
        records.push(record);
      },
    })(PUBLIC_CALL_OPERATIONS.SETTLE);
    const error = new Error(DIAGNOSTIC_CANARY, {
      cause: { prompt: DIAGNOSTIC_CANARY },
    });
    error.stack = DIAGNOSTIC_CANARY;
    attempt.exception(error);
    assert.equal(
      records.at(-1)?.code,
      FACILITATOR_DIAGNOSTIC_CODES.SDK_EXCEPTION,
    );
    attempt.exception(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error(DIAGNOSTIC_CANARY);
          },
          get() {
            throw new Error(DIAGNOSTIC_CANARY);
          },
        },
      ),
    );
    assert.equal(
      records.at(-1)?.code,
      FACILITATOR_DIAGNOSTIC_CODES.SDK_EXCEPTION,
    );
    attempt.exception(
      new ChannelOpenConfirmationError(DIAGNOSTIC_SIGNATURE, error),
    );
    assert.equal(records.at(-1)?.transaction, DIAGNOSTIC_SIGNATURE);
    assert.equal(
      records.at(-1)?.code,
      FACILITATOR_DIAGNOSTIC_CODES.CONFIRMATION_UNKNOWN,
    );
    attempt.exception(new SettlementSimulationError(error));
    assert.equal(
      records.at(-1)?.code,
      FACILITATOR_DIAGNOSTIC_CODES.SIMULATION_REJECTED,
    );
    assert.ok(!JSON.stringify(records).includes(DIAGNOSTIC_CANARY));
  });
  void test('facilitator pending with empty or malformed signature never invents a hint', () => {
    const records: FacilitatorDiagnosticRecord[] = [];
    const attempt = createFacilitatorObserver({
      onDiagnostic(record) {
        records.push(record);
      },
    })(PUBLIC_CALL_OPERATIONS.SETTLE);
    for (const transaction of [
      '',
      DIAGNOSTIC_CANARY,
      'https://private.invalid/',
    ]) {
      attempt.result({
        success: false,
        transaction,
        errorReason: ErrSettlementPending,
      });
      assert.equal(records.at(-1)?.transaction, undefined);
      assert.equal(
        records.at(-1)?.code,
        FACILITATOR_DIAGNOSTIC_CODES.SETTLEMENT_PENDING,
      );
    }
  });
}
